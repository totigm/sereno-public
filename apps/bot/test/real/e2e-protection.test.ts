import { describe, expect, it, vi } from 'vitest'
import { commandRow, enqueueCommand, M15 } from '../helpers/live'
import {
  ALGO,
  algoPosts,
  BOTH,
  BTC,
  BTC_ENTRY,
  closedOf,
  closeEvent,
  cycle,
  decided,
  ENTRY,
  ETH,
  isOrder,
  journaled,
  newAlgos,
  oneR,
  openAt,
  placedBeforeCancelled,
  round2,
  SIGNED_ORDER,
  T,
  tradesOf,
  useRealE2e,
  WAIT,
} from '../helpers/real-e2e'

// La protección de una abierta de plata real en el proceso entero, cuando pasa algo por el
// medio: el motor se rehace, un cierre llena a medias, un apagado no puede cerrar todo o
// alguien toca los algos con el bot apagado.

const e2e = useRealE2e()

describe('la protección de la plata real de punta a punta', { timeout: 30_000 }, () => {
  // La marca y el disparo viajan por sockets distintos: el respaldo por tick del motor puede
  // pedir el cierre antes de que llegue el fill del stop que Binance ya ejecutó.
  it('con Toti en la moneda, el respaldo por tick no le cierra lo suyo cuando el stop ya disparó', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin()
    const [eth] = await openAt(l, real.id)
    l.fakeReal.trading.manualPosition(ETH, eth!.qty)
    // La reconciliación ve la diferencia: el bot sigue con lo suyo.
    await l.clock.advance(60_000)
    await vi.waitFor(async () => expect((await l.t.repos.realEvents.list(real.id, { from: 0, to: l.clock.now() + 1 })).map((e) => e.kind)).toContain('mismatch'), WAIT)
    l.fakeReal.holdUserEvents(true)
    const gap = round2(eth!.stopPrice - 5)
    l.pushMark(ETH, gap)
    // El stop cerró lo del bot; lo que queda es de Toti.
    expect(l.fakeReal.trading.position(ETH)?.amount).toBe(eth!.qty)
    await new Promise((resolve) => setTimeout(resolve, 100))
    l.fakeReal.holdUserEvents(false)

    const [closed] = await closedOf(l, real.id)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'stop', exitPrice: gap })
    expect(l.fakeReal.requests.filter(isOrder('c'))).toEqual([])
    expect(l.fakeReal.trading.position(ETH)?.amount).toBe(eth!.qty)
  })

  it('rehacer el motor (ajustes de riesgo) con una abierta no duplica órdenes y la sigue cuidando', async () => {
    const { paper, real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin()
    const [eth] = await openAt(l, real.id)
    await decided(l, paper.id, T)
    const paperOpen = await l.t.repos.positions.listOpen(paper.id)
    const paperApplied = (await l.t.repos.bot.get(paper.id))?.settingsVersionApplied
    expect(paperOpen).toHaveLength(1)
    const posted = algoPosts(l).length
    const row = await l.t.repos.settings.get(real.id)
    const updated = await l.t.repos.settings.update(real.id, { risk: { ...row!.config.risk, takerFeeRate: 0.0006 } }, row!.version)
    expect(updated.ok).toBe(true)
    await l.clock.advance(10_000)
    await vi.waitFor(async () => expect((await l.t.repos.bot.get(real.id))?.settingsVersionApplied).toBe(updated.version), WAIT)
    expect((await l.t.repos.bot.get(real.id))?.recentErrors).toEqual([])
    expect(algoPosts(l)).toHaveLength(posted)
    expect(newAlgos(l).map((a) => a.clientAlgoId)).toEqual([eth!.stopOrderId, eth!.tpOrderId])
    // La de papel, en el mismo proceso, no se rehízo: su abierta y sus ajustes siguen igual.
    expect(await l.t.repos.positions.listOpen(paper.id)).toEqual(paperOpen)
    expect(await l.t.repos.bot.get(paper.id)).toMatchObject({ settingsVersionApplied: paperApplied, recentErrors: [] })

    // El motor nuevo mueve el stop sobre el mismo adaptador y el cierre trae los números de Binance.
    l.pushMark(ETH, round2(ENTRY + 1.2 * oneR(eth!)))
    await vi.waitFor(async () => expect((await l.t.repos.positions.listOpen(real.id))[0]?.trailingActive).toBe(true), WAIT)
    expect(newAlgos(l).filter((a) => a.orderType === 'STOP_MARKET')).toHaveLength(1)
    const [moved] = await l.t.repos.positions.listOpen(real.id)
    const gap = round2(moved!.stopPrice - 1)
    l.pushMark(ETH, gap)
    const [closed] = await closedOf(l, real.id)
    const [, stop] = tradesOf(l)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'trailing_stop', exitPrice: gap })
    expect(await closeEvent(l, eth!.id)).toMatchObject({ price: gap, fee: Number(stop!.commission), reported: true })
    expect(tradesOf(l)).toHaveLength(2)
  })

  it('un cierre a medias deja stop y take profit por lo que le queda al bot, aunque Binance tarde en tomarlos', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin()
    const [eth] = await openAt(l, real.id)
    // Toti cierra desde el dashboard; Binance llena la mitad y no toma los algos achicados.
    l.fakeTest.trading.partialFillNext(0.5)
    l.fakeTest.trading.rejectNext(ALGO, -1008, undefined, 2)
    l.pushMark(ETH, ENTRY)
    const id = await enqueueCommand(l.t, real.id, 'close_position', { symbol: ETH })
    await l.clock.advance(3_000)
    await vi.waitFor(async () => expect((await commandRow(l.t, real.id, id))?.status).toBe('failed'), WAIT)
    const left = l.fakeTest.trading.position(ETH)!.amount
    expect(left).toBeLessThan(eth!.qty)
    // Un cierre pedido no se reintenta solo: el comando dice qué quedó, no que lo va a cerrar.
    const [, manual] = tradesOf(l)
    expect((await commandRow(l.t, real.id, id))?.result).toEqual({
      ok: false,
      message: `No pude cerrar ETH: cerré ${Number(manual!.qty)} de ${eth!.qty} en ETH; lo demás sigue abierto con su stop. Si querés cerrar lo que quedó, pedilo de nuevo.`,
    })
    expect(newAlgos(l).map((a) => a.quantity)).toEqual([String(eth!.qty), String(eth!.qty)])

    // La reconciliación los lleva a lo que queda, el nuevo antes que el viejo.
    await l.clock.advance(60_000)
    await vi.waitFor(() => expect(newAlgos(l).map((a) => [a.orderType, a.quantity])).toEqual([
      ['STOP_MARKET', String(left)],
      ['TAKE_PROFIT_MARKET', String(left)],
    ]), WAIT)
    expect(await journaled(l, real.id, 'reconciled', `el take profit no era por mis ${left}; lo ajusté`)).toBe(true)
    const [stop, tp] = newAlgos(l)
    placedBeforeCancelled(l, stop!.clientAlgoId, eth!.stopOrderId!)
    placedBeforeCancelled(l, tp!.clientAlgoId, eth!.tpOrderId!)
    expect([stop!.triggerPrice, tp!.triggerPrice]).toEqual([String(eth!.stopPrice), String(eth!.takeProfitPrice)])

    // El take profit dispara por lo que queda y el motor recibe la posición entera.
    l.pushMark(ETH, round2(eth!.takeProfitPrice! + 1))
    const [closed] = await closedOf(l, real.id)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'take_profit' })
    expect(l.fakeTest.trading.position(ETH)).toBeNull()
    // La salida es la mezcla por cantidad del cierre a medias y del take profit, con lo de Binance.
    const [, ...closing] = tradesOf(l)
    expect(closing).toHaveLength(2)
    const sum = (f: (c: (typeof closing)[number]) => number) => closing.reduce((acc, c) => acc + f(c), 0)
    const exit = sum((c) => Number(c.price) * Number(c.qty)) / sum((c) => Number(c.qty))
    const event = await closeEvent(l, eth!.id)
    expect(event).toMatchObject({ qty: eth!.qty, reported: true })
    expect(event!.price).toBeCloseTo(exit, 9)
    expect(event!.fee).toBeCloseTo(sum((c) => Number(c.commission)), 9)
    expect(closed!.exitPrice).toBeCloseTo(exit, 9)
    expect(closed!.pnlGross).toBeCloseTo(sum((c) => Number(c.realizedPnl)), 9)
  })

  it('real_off por comando con un cierre que falla: deja el stop, reintenta y apaga', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin({ scorer: BOTH })
    const open = await openAt(l, real.id, { [ETH]: ENTRY, [BTC]: BTC_ENTRY })
    const opens = l.fakeTest.requests.filter(isOrder('o')).length
    l.fakeTest.trading.rejectNext(SIGNED_ORDER, -4131)
    const id = await enqueueCommand(l.t, real.id, 'real_off')
    await l.clock.advance(3_000)
    await vi.waitFor(async () => expect((await commandRow(l.t, real.id, id))?.status).toBe('failed'), WAIT)
    expect((await commandRow(l.t, real.id, id))?.result).toMatchObject({ message: 'Cerré 1 de 2; las demás las reintento con el próximo precio. La operación quedó apagada.' })
    const failed = open.find((p) => l.fakeTest.trading.position(p.symbol) !== null)!
    expect(newAlgos(l, failed.symbol).map((a) => a.clientAlgoId)).toEqual([failed.stopOrderId, failed.tpOrderId])
    expect(await l.t.repos.sessions.get(real.id)).toMatchObject({ realStatus: 'off', realOffReason: 'user' })

    // La vuelta siguiente la cierra y recién ahí cancela todo lo del bot.
    await l.clock.advance(3_000)
    await vi.waitFor(async () => expect((await l.t.repos.positions.listClosed(real.id)).items.map((c) => c.closeReason)).toEqual(['close_all', 'close_all']), WAIT)
    await vi.waitFor(() => expect(l.fakeTest.trading.algos.filter((a) => a.algoStatus === 'NEW')).toEqual([]), WAIT)
    expect(l.fakeTest.trading.symbolsWithPosition()).toEqual([])
    l.pushMark(ETH, ENTRY)
    l.pushMark(BTC, BTC_ENTRY)
    await cycle(l, T + M15)
    await decided(l, real.id, T + M15)
    expect(l.fakeTest.requests.filter(isOrder('o'))).toHaveLength(opens)
  })

  it('reinicio después de que cancelaron el stop a mano: lo repone una vez y conserva el take profit', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const first = await e2e.begin()
    const [eth] = await openAt(first, real.id)
    const posted = algoPosts(first).length
    await first.runtime.stop()
    // Con el bot apagado, alguien cancela el stop desde Binance.
    first.fakeTest.trading.cancelAlgo({ clientAlgoId: eth!.stopOrderId! })

    const l = await e2e.restart(first, { at: first.clock.now() + 5_000 })
    await l.clock.advance(60_000)
    await vi.waitFor(() => expect(newAlgos(l).filter((a) => a.orderType === 'STOP_MARKET')).toHaveLength(1), WAIT)
    const [stop] = newAlgos(l).filter((a) => a.orderType === 'STOP_MARKET')
    expect(stop).toMatchObject({ triggerPrice: String(eth!.stopPrice), quantity: String(eth!.qty) })
    expect(stop!.clientAlgoId).not.toBe(eth!.stopOrderId)
    expect(newAlgos(l).filter((a) => a.orderType === 'TAKE_PROFIT_MARKET').map((a) => a.clientAlgoId)).toEqual([eth!.tpOrderId])
    await vi.waitFor(async () => expect((await l.t.repos.positions.listOpen(real.id))[0]?.stopOrderId).toBe(stop!.clientAlgoId), WAIT)

    // Otra vuelta de la reconciliación no pone otro.
    await l.clock.advance(60_000)
    await l.clock.advance(60_000)
    expect(algoPosts(l)).toHaveLength(posted + 1)
    expect(l.fakeTest.trading.position(ETH)?.amount).toBe(eth!.qty)
  })
})
