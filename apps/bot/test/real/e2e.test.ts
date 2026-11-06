import type { PositionRecord } from '@sereno/db'
import { describe, expect, it, vi } from 'vitest'
import { priceAt } from '../../src/binance/fake/fixtures'
import { ClientIds } from '../../src/real/client-id'
import { coinOf } from '../../src/real/notes'
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
  HOUR,
  isOrder,
  journaled,
  newAlgos,
  oneR,
  openAt,
  paperRun,
  placedBeforeCancelled,
  READINESS_PATHS,
  realOffCli,
  round2,
  SIGNED_ORDER,
  T,
  tradesOf,
  useRealE2e,
  WAIT,
} from '../helpers/real-e2e'
import { resetRealWorld } from '../helpers/real-live'

// La sesión real dentro del proceso entero (`startLive` con los dos slots), con la de papel al
// lado, contra los Binance falsos: lo que abre el ciclo de 15m, lo que resuelve Binance, los
// reinicios, el interruptor y el tope de pérdida.

const e2e = useRealE2e()

describe('plata real de punta a punta contra el Binance falso', { timeout: 30_000 }, () => {
  it.each(['testnet', 'mainnet'] as const)('en %s abre con stop y TP algorítmicos y la sesión de papel sigue igual', async (env) => {
    // La de papel sola, como antes de la plata real: lo que decide en dos ciclos.
    const alone = await e2e.paperSession()
    const before = await e2e.begin({ env, paperOnly: true })
    const reference = await paperRun(before, alone.id)
    await before.runtime.stop()
    resetRealWorld(e2e.world)

    const { paper, real } = await e2e.sessionsFor(env)
    const l = await e2e.begin({ env })
    expect(l.runtime.status('real')).toEqual({ phase: 'live', sessionId: real.id })
    expect(reference.open).toHaveLength(1)
    expect(await paperRun(l, paper.id)).toEqual(reference)

    const [eth] = await l.t.repos.positions.listOpen(real.id)
    if (!eth) throw new Error('la real no abrió')
    const common = { symbol: ETH, side: 'SELL', quantity: String(eth.qty), reduceOnly: true, closePosition: false, workingType: 'MARK_PRICE', algoStatus: 'NEW' }
    expect(newAlgos(l)).toEqual([
      expect.objectContaining({ ...common, clientAlgoId: eth.stopOrderId, orderType: 'STOP_MARKET', triggerPrice: String(eth.stopPrice) }),
      expect.objectContaining({ ...common, clientAlgoId: eth.tpOrderId, orderType: 'TAKE_PROFIT_MARKET', triggerPrice: String(eth.takeProfitPrice) }),
    ])
    expect(l.fakeReal.trading.position(ETH)?.amount).toBe(eth.qty)
    expect(l.fakeReal.trading.marginType(ETH)).toBe('isolated')
    expect(l.fakeReal.trading.leverage(ETH)).toBe(eth.leverage)
    // El orden de Binance: margen aislado, apalancamiento, la orden y recién ahí stop y TP.
    const writes = l.fakeReal.requests.filter((r) => r.method === 'POST' && r.path !== '/fapi/v1/listenKey').map((r) => r.path)
    expect(writes).toEqual(['/fapi/v1/marginType', '/fapi/v1/leverage', SIGNED_ORDER, ALGO, ALGO])
    // Los números de la apertura son los de Binance.
    const [fill] = tradesOf(l)
    const open = (await l.t.repos.positions.listEvents(eth.id)).find((e) => e.kind === 'open')?.payload
    expect(open).toMatchObject({ price: Number(fill!.price), qty: Number(fill!.qty), fee: Number(fill!.commission), reported: true })
    // Y la otra cuenta no se tocó.
    const other = env === 'testnet' ? l.fakeMain : l.fakeTest
    expect(other.trading.orders).toEqual([])
  })

  it('el trailing pone el stop nuevo antes de cancelar el viejo', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin()
    const [eth] = await openAt(l, real.id)
    const old = eth!.stopOrderId!
    l.pushMark(ETH, round2(ENTRY + 1.2 * oneR(eth!)))
    let moved: PositionRecord | undefined
    await vi.waitFor(async () => {
      moved = (await l.t.repos.positions.listOpen(real.id))[0]
      expect(moved?.stopOrderId).not.toBe(old)
    }, WAIT)
    // El stop nuevo sale a 0,2R de la entrada (1R detrás del mejor precio).
    expect(moved).toMatchObject({ trailingActive: true, stopPrice: round2(ENTRY + 0.2 * oneR(eth!)) })
    placedBeforeCancelled(l, moved!.stopOrderId!, old)
    expect(newAlgos(l).map((a) => [a.orderType, a.clientAlgoId, a.triggerPrice, a.quantity])).toEqual([
      ['TAKE_PROFIT_MARKET', eth!.tpOrderId, String(eth!.takeProfitPrice), String(eth!.qty)],
      ['STOP_MARKET', moved!.stopOrderId, String(moved!.stopPrice), String(eth!.qty)],
    ])
  })

  it('el stop dispara en Binance y el cierre queda en la base con los números de Binance', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin()
    const [eth] = await openAt(l, real.id)
    // La marca salta por debajo del stop: Binance lo ejecuta a esa marca.
    const gap = round2(eth!.stopPrice - 5)
    l.pushMark(ETH, gap)
    const [closed] = await closedOf(l, real.id)
    const [open, stop] = tradesOf(l)
    expect(tradesOf(l)).toHaveLength(2)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'stop', exitPrice: gap })
    expect(Number(stop!.price)).toBe(gap)
    expect(await closeEvent(l, eth!.id)).toMatchObject({ price: gap, qty: eth!.qty, fee: Number(stop!.commission), reported: true })
    expect(closed!.costs.fees).toBeCloseTo(Number(open!.commission) + Number(stop!.commission), 9)
    expect(closed!.pnlGross).toBeCloseTo(Number(stop!.realizedPnl), 9)
    // El take profit hermano se canceló y Binance quedó sin nada del bot.
    expect(l.fakeTest.trading.findAlgo({ clientAlgoId: eth!.tpOrderId! })?.algoStatus).toBe('CANCELED')
    expect(newAlgos(l)).toEqual([])
    expect(l.fakeTest.trading.position(ETH)).toBeNull()
  })

  it('reinicio con una abierta: un solo stop y la posición sigue', async () => {
    const { paper, real } = await e2e.sessionsFor('testnet')
    const first = await e2e.begin()
    const [eth] = await openAt(first, real.id)
    const posted = algoPosts(first).length
    await first.clock.advance(5_000)

    const l = await e2e.restart(first)
    expect(l.runtime.status('real')).toEqual({ phase: 'live', sessionId: real.id })
    expect(l.runtime.status()).toEqual({ phase: 'live', sessionId: paper.id })
    // Retomó la misma abierta y reconoció sus algos: nada nuevo en Binance.
    expect(await l.t.repos.positions.listOpen(real.id)).toEqual([expect.objectContaining({ id: eth!.id, stopOrderId: eth!.stopOrderId, tpOrderId: eth!.tpOrderId })])
    expect(algoPosts(l)).toHaveLength(posted)
    expect(newAlgos(l).map((a) => a.clientAlgoId)).toEqual([eth!.stopOrderId, eth!.tpOrderId])
    expect(l.fakeTest.trading.position(ETH)?.amount).toBe(eth!.qty)

    // La sigue cuidando: el trailing mueve el stop y queda uno solo.
    l.pushMark(ETH, round2(ENTRY + 1.2 * oneR(eth!)))
    await vi.waitFor(async () => expect((await l.t.repos.positions.listOpen(real.id))[0]?.trailingActive).toBe(true), WAIT)
    const stops = newAlgos(l).filter((a) => a.orderType === 'STOP_MARKET')
    expect(stops.map((a) => a.triggerPrice)).toEqual([String(round2(ENTRY + 0.2 * oneR(eth!)))])
  })

  it('corte del user data stream: reconcilia por REST y no pierde el cierre', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    // El stream de la cuenta no vuelve en el rato del test: lo que pase lo ve sólo REST.
    const l = await e2e.begin({ userBackoffMs: { base: 10 * 60_000, max: 10 * 60_000 } })
    const [eth] = await openAt(l, real.id)
    l.fakeTest.dropUserClients()
    // El stop dispara sin nadie conectado: el evento se pierde.
    const gap = round2(eth!.stopPrice - 5)
    l.moveBinance(ETH, gap)
    expect(l.fakeTest.trading.position(ETH)).toBeNull()

    // La vuelta de la reconciliación (a lo sumo un minuto) lo encuentra en los trades.
    await l.clock.advance(60_000)
    await vi.waitFor(async () => expect(await journaled(l, real.id, 'reconciled', 'el stop la había cerrado y yo la seguía teniendo abierta')).toBe(true), WAIT)
    // El motor recibe el cierre con el próximo precio del stream, que ya bajó.
    l.pushMark(ETH, gap)
    const [closed] = await closedOf(l, real.id)
    const [, stop] = tradesOf(l)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'stop', exitPrice: gap })
    expect(await closeEvent(l, eth!.id)).toMatchObject({ price: gap, qty: eth!.qty, fee: Number(stop!.commission), reported: true })
    // Sin una segunda orden ni reconexión del stream: lo resolvió la reconciliación.
    expect(tradesOf(l)).toHaveLength(2)
    expect(l.fakeTest.requests.filter(isOrder('c'))).toEqual([])
    expect(l.fakeTest.userConnections).toHaveLength(1)
  })

  it('sin la variable sigue cuidando: no abre, el trailing mueve el stop y la salida por tiempo cierra', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    // Dos días después, a las 12:15: la salida por tiempo (48 h) vence en ese ciclo.
    const later = T + 48 * HOUR
    // La marca de la apertura es la que el REST del falso va a dar al reiniciar.
    const entry = round2(priceAt(ETH, later - 20_000))
    const first = await e2e.begin()
    const [eth] = await openAt(first, real.id, { [ETH]: entry })
    const r = oneR(eth!)
    const posted = algoPosts(first).length
    const opens = first.fakeTest.requests.filter(isOrder('o')).length

    const l = await e2e.restart(first, { enabled: false, at: later - 20_000 })
    expect(l.runtime.status('real')).toEqual({ phase: 'live', sessionId: real.id })
    await l.clock.advance(10_000)
    await vi.waitFor(async () => expect((await l.t.repos.bot.get(real.id))?.real).toEqual({ mode: 'reduce_only', missing: ['SERENO_REAL_TRADING=on'] }), WAIT)
    expect(algoPosts(l)).toHaveLength(posted)

    // Mover el stop a favor sólo reduce riesgo: el nuevo antes de cancelar el viejo.
    l.pushMark(ETH, round2(entry + 1.2 * r))
    await vi.waitFor(async () => expect((await l.t.repos.positions.listOpen(real.id))[0]?.trailingActive).toBe(true), WAIT)
    const [moved] = await l.t.repos.positions.listOpen(real.id)
    placedBeforeCancelled(l, moved!.stopOrderId!, eth!.stopOrderId!)

    // Vuelve a 0,25R (sobre el stop nuevo, bajo el mínimo de la salida por tiempo): el ciclo la cierra.
    l.pushMark(ETH, round2(entry + 0.25 * r))
    await cycle(l, later)
    const [closed] = await closedOf(l, real.id)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'time_exit' })
    expect(l.fakeTest.requests.filter(isOrder('c'))).toHaveLength(1)
    // Nunca abrió: ni ETH otra vez (S′ 0,8) ni nada.
    expect(l.fakeTest.requests.filter(isOrder('o'))).toHaveLength(opens)
    expect(await l.t.repos.positions.listOpen(real.id)).toEqual([])
    expect(l.fakeTest.trading.position(ETH)).toBeNull()
    await vi.waitFor(() => expect(newAlgos(l)).toEqual([]), WAIT)
  })

  it('tope de pérdida: todo cerrado, apagada por el tope y sin algos del bot hasta una sesión nueva', async () => {
    // Tope del 10%: el piso es US$ 900.
    const { real } = await e2e.sessionsFor('testnet', 0.1)
    const l = await e2e.begin({ scorer: BOTH })
    const [btc, eth] = await openAt(l, real.id, { [ETH]: ENTRY, [BTC]: BTC_ENTRY })
    expect([btc!.symbol, eth!.symbol]).toEqual([BTC, ETH])
    // Un hueco en ETH: el stop se ejecuta muy por debajo y la equity cae bajo el piso.
    const gap = round2(eth!.liquidationPrice + 2)
    expect(eth!.qty * (eth!.entryPrice - gap)).toBeGreaterThan(100)
    l.pushMark(ETH, gap)
    const closed = await closedOf(l, real.id, 2)
    expect(Object.fromEntries(closed.map((c) => [c.symbol, c.closeReason]))).toEqual({ [ETH]: 'stop', [BTC]: 'loss_floor' })
    await vi.waitFor(async () => expect((await l.t.repos.sessions.get(real.id))?.realStatus).toBe('loss_floor'), WAIT)
    expect(await journaled(l, real.id, 'loss_floor')).toBe(true)
    expect(l.fakeTest.trading.algos.filter((a) => a.algoStatus === 'NEW')).toEqual([])
    expect(l.fakeTest.trading.symbolsWithPosition()).toEqual([])

    // La base no deja prenderla otra vez y el ciclo siguiente no abre nada.
    expect(await l.t.repos.sessions.setRealStatus(real.id, 'on', null)).toBe(false)
    const opens = l.fakeTest.requests.filter(isOrder('o')).length
    l.pushMark(ETH, ENTRY)
    l.pushMark(BTC, BTC_ENTRY)
    await cycle(l, T + M15)
    await vi.waitFor(async () => expect((await l.t.repos.bot.get(real.id))?.real).toEqual({ mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] }), WAIT)
    await decided(l, real.id, T + M15)
    expect(l.fakeTest.requests.filter(isOrder('o'))).toHaveLength(opens)

    // Con una sesión nueva (con lo que quedó en la billetera) vuelve a operar.
    const next = await e2e.nextReal({ realEnv: 'testnet', capital: 800 })
    await l.clock.advance(10_000)
    await vi.waitFor(() => expect(l.runtime.status('real')).toEqual({ phase: 'live', sessionId: next.id }), WAIT)
    l.openStreams()
    l.pushMark(ETH, ENTRY)
    l.pushMark(BTC, BTC_ENTRY)
    await cycle(l, T + 2 * M15)
    await vi.waitFor(async () => expect((await l.t.repos.positions.listOpen(next.id)).length).toBeGreaterThan(0), WAIT)
  })

  it('al arrancar, la sesión nueva cancela los stops que dejó la archivada en una moneda sin posición', async () => {
    const { real: old } = await e2e.sessionsFor('testnet')
    const next = await e2e.nextReal({ realEnv: 'testnet', capital: 800 })
    // La cancelación al llegar al tope falló: el stop de BTC de la archivada sigue en Binance.
    const leftover = new ClientIds(old.id, () => T).next('s')
    const algo = { side: 'SELL', type: 'STOP_MARKET', quantity: '0.01', reduceOnly: true, workingType: 'MARK_PRICE', priceProtect: false } as const
    e2e.world.fakeTest.trading.setMark(BTC, BTC_ENTRY)
    e2e.world.fakeTest.trading.placeAlgo({ ...algo, symbol: BTC, triggerPrice: String(round2(BTC_ENTRY * 0.9)), clientAlgoId: leftover })
    e2e.world.fakeTest.trading.placeAlgo({ ...algo, symbol: BTC, triggerPrice: String(round2(BTC_ENTRY * 0.8)), clientAlgoId: 'web_stop_de_toti' })

    const l = await e2e.begin()
    expect(l.runtime.status('real')).toEqual({ phase: 'live', sessionId: next.id })

    expect(await journaled(l, next.id, 'reconciled', 'sesión real archivada')).toBe(true)
    const status = Object.fromEntries(l.fakeTest.trading.algos.map((a) => [a.clientAlgoId, a.algoStatus]))
    expect(status).toEqual({ [leftover]: 'CANCELED', web_stop_de_toti: 'NEW' })
  })

  it('real-off por CLI con el bot vivo: cierra con close_all, la que falla conserva su stop y no vuelve a abrir', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin({ scorer: BOTH })
    const [btc, eth] = await openAt(l, real.id, { [ETH]: ENTRY, [BTC]: BTC_ENTRY })
    const opens = l.fakeTest.requests.filter(isOrder('o')).length
    // El CLI cierra en el orden de la base (BTC primero) y ese cierre lo rechaza Binance.
    l.fakeTest.trading.rejectNext(SIGNED_ORDER, -4131)
    const out: string[] = []
    expect(await realOffCli(l, out)).toBe(1)
    expect(out).toContain('BTC: no la pude cerrar y le dejé el stop puesto: Binance rechazó la orden: el mejor precio del libro está fuera del rango permitido')
    expect(out.at(-1)).toBe('Cerré 1 de 2; la operación quedó apagada.')
    expect(l.fakeTest.trading.position(BTC)?.amount).toBe(btc!.qty)
    expect(l.fakeTest.trading.position(ETH)).toBeNull()
    expect(newAlgos(l, ETH)).toEqual([])
    expect(newAlgos(l, BTC).map((a) => a.clientAlgoId)).toEqual([btc!.stopOrderId, btc!.tpOrderId])
    expect(await l.t.repos.sessions.get(real.id)).toMatchObject({ realStatus: 'off', realOffReason: 'user' })

    // El bot ve el apagado y, con su reconciliación, el cierre del interruptor.
    await l.clock.advance(60_000)
    await vi.waitFor(async () => expect(await journaled(l, real.id, 'reconciled', `${coinOf(ETH)}: el interruptor la había cerrado`)).toBe(true), WAIT)
    l.pushMark(ETH, eth!.entryPrice)
    const [closed] = await closedOf(l, real.id)
    expect(closed).toMatchObject({ id: eth!.id, closeReason: 'close_all' })
    await vi.waitFor(async () => expect((await l.t.repos.bot.get(real.id))?.real).toEqual({ mode: 'reduce_only', missing: ['prenderla en Ajustes'] }), WAIT)
    // La que no se pudo cerrar sigue con su stop y el bot no abre nada en el ciclo.
    l.pushMark(ETH, ENTRY)
    l.pushMark(BTC, BTC_ENTRY)
    await cycle(l, T + M15)
    await decided(l, real.id, T + M15)
    expect(l.fakeTest.requests.filter(isOrder('o'))).toHaveLength(opens)
    expect(newAlgos(l, BTC).map((a) => a.clientAlgoId)).toEqual([btc!.stopOrderId, btc!.tpOrderId])

    // Otra vez el CLI: ahora cierra la que quedaba.
    expect(await realOffCli(l, out)).toBe(0)
    expect(out.at(-1)).toBe('Cerré todo y apagué la operación con plata real.')
    await l.clock.advance(60_000)
    await vi.waitFor(async () => expect(await journaled(l, real.id, 'reconciled', `${coinOf(BTC)}: el interruptor la había cerrado`)).toBe(true), WAIT)
    l.pushMark(BTC, btc!.entryPrice)
    await vi.waitFor(async () => expect((await l.t.repos.positions.listClosed(real.id)).items.map((c) => c.closeReason)).toEqual(['close_all', 'close_all']), WAIT)
    expect(l.fakeTest.trading.algos.filter((a) => a.algoStatus === 'NEW')).toEqual([])
  })

  it('una sesión de testnet nunca opera con mainnet', async () => {
    const { paper, real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin({ env: 'mainnet' })
    expect(l.runtime.status('real')).toEqual({ phase: 'off', sessionId: real.id })
    await l.clock.advance(10_000)
    await vi.waitFor(async () => expect(await l.t.repos.bot.get(real.id)).toMatchObject({ phase: 'off', real: { mode: 'unguarded', missing: ['el entorno: la sesión es de testnet'] } }), WAIT)
    l.pushMark(ETH, ENTRY)
    await cycle(l, T)
    await vi.waitFor(async () => expect(await l.t.repos.positions.listOpen(paper.id)).toHaveLength(1), WAIT)
    expect(await l.t.repos.positions.listOpen(real.id)).toEqual([])
    // A mainnet sólo le pidió la revisión de la cuenta (el dashboard la lee); nada de la sesión.
    const signed = l.fakeMain.requests.filter((r) => r.query.signature !== undefined || r.path === '/fapi/v1/listenKey')
    expect(signed.length).toBeGreaterThan(0)
    expect(signed.filter((r) => r.method !== 'GET' || !READINESS_PATHS.has(r.path))).toEqual([])
    expect(l.fakeMain.trading.orders).toEqual([])
  })

  it('un real_off del dashboard a una sesión de otro entorno falla con el motivo en vez de quedar esperando', async () => {
    const { real } = await e2e.sessionsFor('testnet')
    const l = await e2e.begin({ env: 'mainnet' })
    expect(l.runtime.status('real')).toEqual({ phase: 'off', sessionId: real.id })
    const id = await enqueueCommand(l.t, real.id, 'real_off')

    await l.clock.advance(10_000)

    await vi.waitFor(async () => expect(await commandRow(l.t, real.id, id)).toMatchObject({ status: 'failed', result: { ok: false, message: 'No hice nada: esta sesión no habla con Binance (falta el entorno: la sesión es de testnet).' } }), WAIT)
    expect(l.fakeMain.trading.orders).toEqual([])
  })
})
