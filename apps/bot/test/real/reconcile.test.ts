import type { StopOrder } from '@sereno/core/src/exchange/types'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { createLogger } from '../../src/logger'
import { ADOPTED_REASON, Reconciler, reconcileAtStart, type ReconcilerOptions } from '../../src/real/reconcile'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'
import { adapterFor, drive, markTick, REAL_INFOS, REAL_SESSION, REAL_T0, realEngine, realRig, realView, restoredState, type RealRig } from '../helpers/real'

const WAIT = { timeout: 3_000, interval: 5 }
const SOL = 'SOLUSDT'
const ETH = 'ETHUSDT'
const stopFor = (stopPrice: number, qty: number): StopOrder => ({ symbol: SOL, side: 'sell', stopPrice, qty, reduceOnly: true })

describe('reconciliación con Binance', () => {
  let fake: FakeBinance
  let t: TestDb
  const rigs: RealRig[] = []

  const live = (status = 'NEW') => fake.trading.algos.filter((a) => a.algoStatus === status && a.clientAlgoId.startsWith('sereno-'))

  async function rig(clock?: RealRig['clock']): Promise<RealRig> {
    const r = await realRig(fake, clock ? { clock } : {})
    rigs.push(r)
    return r
  }

  // El bot se apaga: el adaptador deja de escuchar y la cuenta cierra el stream.
  async function shutdown(r: RealRig): Promise<void> {
    r.exchange.detach()
    await r.account.stop()
    rigs.splice(rigs.indexOf(r), 1)
  }

  function startDeps(r: RealRig, atr: number | null = null) {
    return {
      repos: t.repos,
      account: r.account,
      trade: r.kit.trade,
      stops: { trade: r.kit.trade, ids: r.ids, clock: r.clock, delaysMs: [0] },
      sessionId: REAL_SESSION,
      infos: REAL_INFOS,
      atr1h: async () => atr,
      settings: DEFAULT_SETTINGS,
      now: r.clock.now(),
    }
  }

  function reconciler(r: RealRig, overrides: Partial<ReconcilerOptions> = {}): Reconciler {
    return new Reconciler({ account: r.account, exchange: r.exchange, trade: r.kit.trade, clock: r.clock, onNote: (n) => r.notes.push(n), ...overrides })
  }

  // Abre ETH con el motor y la guarda como lo haría el runtime.
  async function openWithEngine(r: RealRig) {
    r.exchange.setPrices(ETH, { mark: 2_000, last: 2_000 })
    const { engine } = realEngine(r, { [ETH]: 0.9 })
    await r.clock.advance(2_000)
    const cycle = await engine.onCandleClose([realView(ETH, REAL_T0, 2_000, 20)], { missingSymbols: [], degraded: [] })
    const opened = cycle.opened[0]!
    await t.repos.positions.upsertOpen(REAL_SESSION, opened)
    return opened
  }

  beforeAll(async () => {
    fake = await FakeBinance.start()
    t = await openTestDb()
  })
  afterAll(async () => {
    await t.query('delete from sessions where id = $1', [REAL_SESSION])
    await t.close()
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark(SOL, 150)
    fake.trading.setMark(ETH, 2_000)
    await seedSession(t, REAL_SESSION, 'replay')
  })
  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      r.exchange.detach()
      await r.account.stop()
    }
  })

  it('reiniciar no duplica stops', async () => {
    const first = await rig()
    await openWithEngine(first)
    expect(live().map((a) => a.orderType)).toEqual(['STOP_MARKET', 'TAKE_PROFIT_MARKET'])
    await shutdown(first)

    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start).toEqual({ pendingCloses: new Map(), adopted: [], foreign: [], vanished: [], notes: [] })
    const { engine } = realEngine(r, {})
    await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    await engine.onMarkTick(markTick(ETH, 2_001, r.clock.now()))

    expect(fake.trading.algos.map((a) => [a.orderType, a.algoStatus])).toEqual([
      ['STOP_MARKET', 'NEW'],
      ['TAKE_PROFIT_MARKET', 'NEW'],
    ])
    expect(fake.requests.filter((q) => q.method === 'POST' && q.path === '/fapi/v1/algoOrder')).toHaveLength(2)
  })

  it('cerrada por el stop con el bot apagado: cierre con el fill real y motivo stop', async () => {
    const first = await rig()
    const opened = await openWithEngine(first)
    await shutdown(first)
    // Con el bot apagado la marca cruza el stop y Binance lo dispara.
    fake.trading.setMark(ETH, opened.stopPrice - 1)
    expect(fake.trading.position(ETH)).toBeNull()
    const stopTrade = fake.trading.trades.at(-1)!

    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    const close = start.pendingCloses.get(ETH)!
    expect(close).toMatchObject({ reason: 'stop', orderId: opened.stopOrderId, triggerPrice: opened.stopPrice, fill: { qty: opened.qty, avgPrice: Number(stopTrade.price) } })
    expect(close.fill.commission).toBeCloseTo(Number(stopTrade.commission), 12)
    expect(start.notes).toEqual([
      { kind: 'reconciled', symbol: ETH, phrase: 'Binance y yo no coincidíamos en ETH: el stop la había cerrado y yo la seguía teniendo abierta. Lo corregí.', data: { reason: 'stop', positionId: opened.id } },
    ])

    const { engine, events } = realEngine(r, {})
    await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    r.exchange.queueClose(ETH, close)
    await engine.onMarkTick(markTick(ETH, opened.stopPrice - 1, r.clock.now()))
    const closed = events.flatMap((e) => (e.type === 'position_closed' ? [e] : []))
    expect(closed.map((e) => [e.position.closeReason, e.fill.reported, e.fill.price])).toEqual([['stop', true, Number(stopTrade.price)]])
    const realized = fake.trading.trades.reduce((s, x) => s + Number(x.realizedPnl) - Number(x.commission), 0)
    expect(closed[0]!.position.pnlNet).toBeCloseTo(realized, 8)
    // El motor no quiso poner otro stop ni mandó ninguna orden.
    expect(fake.trading.orders).toHaveLength(2)
    expect(fake.trading.algos).toHaveLength(2)
  })

  it('posición sin rastro en la base pero con fill o: se adopta con stop', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    const fill = await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    // El bot se cae antes de guardarla.
    await shutdown(first)

    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r, 1.5))
    expect(start.adopted).toEqual([SOL])
    expect(start.foreign).toEqual([])
    const [row] = await t.repos.positions.listOpen(REAL_SESSION)
    // k·ATR(1h) = 2 · 1,5 = 3 debajo de la entrada; el take profit a tpR·R.
    expect(row).toMatchObject({ symbol: SOL, side: 'long', qty: 2, entryPrice: 150, leverage: 3, stopPrice: 147, takeProfitPrice: 156, openReason: ADOPTED_REASON, feesPaid: fill.fee })
    expect(start.notes).toEqual([
      { kind: 'adopted', symbol: SOL, phrase: 'Adopté 2 SOL de Binance: me caí entre la orden y el guardado. Le pongo stop en 147.', data: { positionId: row!.id, qty: 2, entryPrice: 150, stopPrice: 147 } },
    ])
    expect((await t.repos.positions.listEvents(row!.id)).map((e) => e.kind)).toEqual(['open'])

    // El motor la retoma y la protege con el stop de la adopción.
    const { engine } = realEngine(r, {})
    await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    await engine.onMarkTick(markTick(SOL, 150, r.clock.now()))
    expect(live().map((a) => [a.orderType, a.triggerPrice, a.quantity])).toEqual([
      ['STOP_MARKET', '147.00', '2'],
      ['TAKE_PROFIT_MARKET', '156.00', '2'],
    ])
  })

  // Sin depender del primer precio por REST del arranque: si ese pedido falla, el arranque se
  // reintenta en un minuto y la adoptada, por definición, no tenía stop.
  it('la adoptada tiene su stop en Binance antes de retomar el motor, y el motor lo reutiliza', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await shutdown(first)

    const r = await rig(first.clock)
    await reconcileAtStart(startDeps(r, 1.5))
    const [adopted] = live()
    expect(live().map((a) => [a.orderType, a.side, a.triggerPrice, a.quantity, a.reduceOnly])).toEqual([['STOP_MARKET', 'SELL', '147.00', '2', true]])
    expect(adopted!.clientAlgoId).toMatch(/^sereno-0a1b2c3d-s/)

    const { engine } = realEngine(r, {})
    await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    await engine.onMarkTick(markTick(SOL, 150, r.clock.now()))
    expect(live().filter((a) => a.orderType === 'STOP_MARKET').map((a) => a.clientAlgoId)).toEqual([adopted!.clientAlgoId])
  })

  it('si Binance no toma el stop de la adoptada, lo avisa y la adopción sigue: lo reintenta el motor', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await shutdown(first)

    const r = await rig(first.clock)
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1008)
    const start = await reconcileAtStart(startDeps(r, 1.5))
    expect(start.adopted).toEqual([SOL])
    expect(live()).toEqual([])
    expect(start.notes.map((n) => n.kind)).toEqual(['adopted', 'rejected'])
  })

  it('sin ATR de 1h el stop de la adoptada va al 2% de la entrada', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await shutdown(first)
    const r = await rig(first.clock)
    await reconcileAtStart(startDeps(r, null))
    expect((await t.repos.positions.listOpen(REAL_SESSION))[0]).toMatchObject({ stopPrice: 147, distanciaStop: 0.02 })
  })

  it('posición sin fill del bot: es de Toti y no se toca', async () => {
    fake.trading.manualPosition(SOL, 3)
    const r = await rig()
    const before = fake.requests.length
    const start = await reconcileAtStart(startDeps(r))
    expect(start).toEqual({
      pendingCloses: new Map(),
      adopted: [],
      foreign: [SOL],
      vanished: [],
      notes: [{ kind: 'foreign_position', symbol: SOL, phrase: 'tenés una posición tuya en SOL; no la toco', data: { amount: 3 } }],
    })
    expect(await t.repos.positions.listOpen(REAL_SESSION)).toEqual([])
    expect(fake.requests.slice(before).filter((q) => q.method !== 'GET')).toEqual([])
  })

  it('un fill o ya cerrado no explica lo que Toti abrió después', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await first.exchange.closePosition(SOL, 'signal_flip')
    await shutdown(first)
    fake.trading.manualPosition(SOL, 2)
    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start.adopted).toEqual([])
    expect(start.foreign).toEqual([SOL])
  })

  it('stop cancelado a mano en Binance: lo repone en el próximo tick', async () => {
    const r = await rig()
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.trading.cancelAlgo({ clientAlgoId: stopId })

    await reconciler(r).tick()
    expect(live().map((a) => [a.orderType, a.triggerPrice, a.quantity])).toEqual([['STOP_MARKET', '145.00', '2']])
    expect(r.notes).toEqual([{ kind: 'reconciled', symbol: SOL, phrase: 'Binance y yo no coincidíamos en SOL: le faltaba el stop en Binance; lo repuse. Lo corregí.', data: { stop: 'replaced' } }])
    // Con el stop puesto, otra vuelta no toca nada.
    await reconciler(r).tick()
    expect(fake.trading.algos).toHaveLength(2)
    expect(r.notes).toHaveLength(1)
  })

  it('una posición del bot que desapareció sin evento se cierra con el fill de Binance', async () => {
    const r = await rig()
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    const stopId = await r.exchange.placeStopMarket(stopFor(145, 2))
    fake.holdUserEvents(true)
    fake.trading.setMark(SOL, 144)

    await reconciler(r).tick()
    expect(r.exchange.hasPendingClose(SOL)).toBe(true)
    expect(r.notes.map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: el stop la había cerrado y yo la seguía teniendo abierta. Lo corregí.'])
    // El evento que llega tarde no agrega otro cierre.
    fake.holdUserEvents(false)
    await vi.waitFor(() => expect(r.account.position(SOL)).toBeNull(), WAIT)
    const triggered = r.exchange.processTick(markTick(SOL, 144, r.clock.now()))
    expect(triggered).toMatchObject([{ reason: 'stop', orderId: stopId, fill: { qty: 2, price: 144, reported: true } }])
    expect(r.exchange.processTick(markTick(SOL, 144, r.clock.now()))).toEqual([])
  })

  it('cancela los algos del bot que quedaron sin posición del bot', async () => {
    const first = await rig()
    first.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await first.exchange.setLeverage(SOL, 3)
    await first.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await first.exchange.placeStopMarket(stopFor(145, 2))
    await vi.waitFor(() => expect(first.account.botAlgos(SOL)).toHaveLength(1), WAIT)
    // Un adaptador nuevo que no la retoma (la posición ya no es del bot para la base).
    first.exchange.detach()
    const r = { ...first, exchange: adapterFor(first) }
    rigs.splice(rigs.indexOf(first), 1, r)
    await reconciler(r).tick()
    expect(fake.trading.algos.map((a) => a.algoStatus)).toEqual(['CANCELED'])
    expect(r.notes.map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: quedaba un stop del bot sin posición; lo cancelé. Lo corregí.'])
    // La posición de Binance queda: ahora es de Toti.
    expect(fake.trading.position(SOL)!.amount).toBe(2)
  })

  it('con el stream caído reconcilia cada 10 s', async () => {
    const r = await rig()
    let up = true
    let rounds = 0
    const account = {
      sync: () => {
        rounds += 1
        return r.account.sync()
      },
      get streamUp() {
        return up
      },
    }
    const loop = reconciler(r, { account })
    expect(loop.intervalMs()).toBe(60_000)
    loop.start()
    await r.clock.advance(0)
    await vi.waitFor(() => expect(rounds).toBe(1), WAIT)
    await r.clock.advance(10_000)
    expect(rounds).toBe(1)

    up = false
    expect(loop.intervalMs()).toBe(10_000)
    await r.clock.advance(50_000)
    await vi.waitFor(() => expect(rounds).toBe(2), WAIT)
    for (let i = 1; i <= 3; i++) {
      await r.clock.advance(10_000)
      await vi.waitFor(() => expect(rounds).toBe(2 + i), WAIT)
    }
    loop.stop()
    await r.clock.advance(60_000)
    expect(rounds).toBe(5)
  })

  // ---------- Toti abrió del mismo lado con el bot apagado ----------

  // Un adaptador nuevo sobre la cuenta de `r` que arranca con lo que encontró `reconcileAtStart`.
  function withStart(r: RealRig, start: Awaited<ReturnType<typeof reconcileAtStart>>): RealRig {
    r.exchange.detach()
    const next = { ...r, exchange: adapterFor(r, { atStart: start }) }
    rigs.splice(rigs.indexOf(r), 1, next)
    return next
  }

  it('cerrada por el stop con el bot apagado y Toti abrió del mismo lado: se cierra y lo de Toti no se toca', async () => {
    const first = await rig()
    const opened = await openWithEngine(first)
    await shutdown(first)
    await first.clock.advance(60_000)
    fake.trading.setMark(ETH, opened.stopPrice - 1)
    expect(fake.trading.position(ETH)).toBeNull()
    const stopTrade = fake.trading.trades.at(-1)!
    await first.clock.advance(60_000)
    fake.trading.manualPosition(ETH, 0.5)

    let r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start.pendingCloses.get(ETH)).toMatchObject({ reason: 'stop', orderId: opened.stopOrderId, fill: { qty: opened.qty, avgPrice: Number(stopTrade.price) } })
    expect(start.foreign).toEqual([ETH])
    expect(start.notes).toEqual([
      { kind: 'reconciled', symbol: ETH, phrase: 'Binance y yo no coincidíamos en ETH: el stop la había cerrado y yo la seguía teniendo abierta. Lo corregí.', data: { reason: 'stop', positionId: opened.id } },
      { kind: 'foreign_position', symbol: ETH, phrase: 'tenés una posición tuya en ETH; no la toco', data: { amount: 0.5 } },
    ])

    r = withStart(r, start)
    const { engine, events } = realEngine(r, {})
    const restored = await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    // Lo que muestra Binance es de Toti: ni diferencia ni liquidación recalculada.
    expect(restored.liquidations).toEqual([])
    expect(r.notes).toEqual([])
    await engine.onMarkTick(markTick(ETH, 2_000, r.clock.now()))
    const closed = events.flatMap((e) => (e.type === 'position_closed' ? [e] : []))
    expect(closed.map((e) => [e.position.closeReason, e.fill.price])).toEqual([['stop', Number(stopTrade.price)]])
    // Ningún stop ni orden del bot sobre lo de Toti: el take profit que quedó se cancela.
    expect(fake.trading.algos.filter((a) => a.symbol === ETH)).toHaveLength(2)
    await vi.waitFor(() => expect(live().filter((a) => a.symbol === ETH)).toEqual([]), WAIT)
    expect(fake.trading.orders.filter((o) => o.clientOrderId.startsWith('sereno-'))).toHaveLength(1)
    expect(fake.trading.position(ETH)!.amount).toBe(0.5)
  })

  it('el stop del bot disparó con el bot apagado aunque Toti siga con lo suyo del mismo lado', async () => {
    const first = await rig()
    const opened = await openWithEngine(first)
    await first.clock.advance(60_000)
    fake.trading.manualPosition(ETH, 0.5)
    await shutdown(first)
    await first.clock.advance(60_000)
    fake.trading.setMark(ETH, opened.stopPrice - 1)
    // El stop redujo sólo lo del bot: Binance nunca quedó en cero.
    expect(fake.trading.position(ETH)!.amount).toBeCloseTo(0.5, 12)

    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start.pendingCloses.get(ETH)).toMatchObject({ reason: 'stop', orderId: opened.stopOrderId, fill: { qty: opened.qty } })
    expect(start.foreign).toEqual([ETH])
  })

  it('ventas de Toti que suman la cantidad del bot no cierran la del bot', async () => {
    const first = await rig()
    const opened = await openWithEngine(first)
    await shutdown(first)
    await first.clock.advance(60_000)
    fake.trading.manualPosition(ETH, 1)
    await first.clock.advance(60_000)
    fake.trading.manualPosition(ETH, -opened.qty)

    const r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start).toEqual({ pendingCloses: new Map(), adopted: [], foreign: [], vanished: [], notes: [] })
  })

  // ---------- Una moneda no frena a las demás ----------

  it('un error en una moneda no frena la vuelta de las demás', async () => {
    const r = await rig()
    const funding = { collect: vi.fn(async () => []) }
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await openWithEngine(r)
    // Toti cierra a mano la de SOL y cancela el stop de ETH.
    fake.trading.manualPosition(SOL, -2)
    const ethStop = live().find((a) => a.symbol === ETH && a.orderType === 'STOP_MARKET')!
    fake.trading.cancelAlgo({ clientAlgoId: ethStop.clientAlgoId })
    // Buscar el cierre de SOL falla.
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 400, body: { code: -1121, msg: 'Invalid symbol.' } })

    await reconciler(r, { funding }).tick()
    expect(live().filter((a) => a.orderType === 'STOP_MARKET').map((a) => [a.symbol, a.triggerPrice])).toEqual([[ETH, ethStop.triggerPrice]])
    expect(funding.collect).toHaveBeenCalledTimes(1)
    expect(r.exchange.hasPendingClose(SOL)).toBe(false)

    await reconciler(r, { funding }).tick()
    expect(r.exchange.hasPendingClose(SOL)).toBe(true)
  })

  // ---------- Apertura en duda ----------

  it('una apertura en duda que Binance llenó tarde la cierra la vuelta siguiente', async () => {
    let r = await rig()
    r.exchange.detach()
    r = { ...r, exchange: adapterFor(r, { retry: { delaysMs: [0], fillTimeoutMs: 1_000 } }) }
    rigs.splice(rigs.length - 1, 1, r)
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    fake.failNext('/fapi/v1/order', { method: 'POST', status: 500, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } })
    await expect(drive(r.clock, r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 }))).rejects.toMatchObject({ reason: 'exchange_rejected' })
    const doubtful = fake.requests.filter((q) => q.method === 'POST' && q.path === '/fapi/v1/order').at(-1)!.query.newClientOrderId!
    fake.trading.placeMarket({ symbol: SOL, side: 'BUY', qty: 2, reduceOnly: false, clientOrderId: doubtful })

    await drive(r.clock, reconciler(r).tick())
    expect(fake.trading.position(SOL)).toBeNull()
    expect(r.notes.map((n) => n.kind)).toEqual(['unprotected'])
    expect(fake.trading.orders.map((o) => [o.clientOrderId.slice(0, 17), o.side, o.origQty, o.reduceOnly])).toEqual([
      ['sereno-0a1b2c3d-o', 'BUY', '2', false],
      ['sereno-0a1b2c3d-c', 'SELL', '2', true],
    ])
  })

  // ---------- Desaparecida sin trades todavía ----------

  // Una vuelta de la reconciliación en la que `positionRisk` no muestra nada y los trades
  // tampoco (una foto atrasada, o un cierre que Binance todavía no publicó).
  function laggingSnapshot(): void {
    fake.failNext('/fapi/v2/positionRisk', { method: 'GET', status: 200, body: [] })
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 200, body: [] })
  }

  async function solWithProtection(r: RealRig): Promise<void> {
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 2 })
    await r.exchange.placeStopMarket(stopFor(145, 2))
    await r.exchange.placeTakeProfitMarket(stopFor(160, 2))
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(2), WAIT)
  }

  // Stop primero, después el take profit.
  const solProtection = () =>
    live()
      .filter((a) => a.symbol === SOL)
      .map((a) => [a.orderType, a.triggerPrice, a.quantity])
      .sort((a, b) => a[0]!.localeCompare(b[0]!))

  it('una foto atrasada de positionRisk no cancela la protección y se olvida si la posición sigue', async () => {
    const r = await rig()
    await solWithProtection(r)
    laggingSnapshot()
    await reconciler(r).tick()
    // En duda: nada nuevo ahí, pero el stop y el take profit siguen cubriendo.
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '2'],
      ['TAKE_PROFIT_MARKET', '160.00', '2'],
    ])
    await expect(r.exchange.placeStopMarket(stopFor(146, 2))).rejects.toThrow(/no muestra la posición del bot en SOLUSDT/)

    // La vuelta siguiente la ve: era una foto atrasada.
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    expect(r.notes).toEqual([])
    await r.exchange.placeStopMarket(stopFor(146, 2))
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '146.00', '2'],
      ['TAKE_PROFIT_MARKET', '160.00', '2'],
    ])

    // Otra foto atrasada suelta vuelve a dejarla en duda, sin confirmarla.
    laggingSnapshot()
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    expect(solProtection()).toHaveLength(2)
  })

  it('dos fotos seguidas sin la posición la dan por desaparecida; si vuelve con la cantidad del bot, recupera la protección', async () => {
    const r = await rig()
    await solWithProtection(r)
    laggingSnapshot()
    await reconciler(r).tick()
    // Dos fotos casi juntas no alcanzan: pueden venir del mismo nodo atrasado.
    laggingSnapshot()
    await reconciler(r).tick()
    expect(solProtection()).toHaveLength(2)
    laggingSnapshot()
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    await vi.waitFor(() => expect(solProtection()).toEqual([]), WAIT)

    await r.clock.advance(10_000)
    await reconciler(r).tick()
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '2'],
      ['TAKE_PROFIT_MARKET', '160.00', '2'],
    ])
    expect(r.notes.map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: volvió a aparecer; le repuse la protección. Lo corregí.'])
    await r.exchange.placeStopMarket(stopFor(146, 2))
  })

  // Bot 1 y Toti 2 en SOL: Binance muestra 3, nunca la cantidad del bot sola.
  it.each([
    ['vuelve con lo mismo que había', 0, 3],
    ['Toti sumó mientras tanto', 1, 4],
  ])('desaparecida por fotos atrasadas con Toti en la moneda: si vuelve sin cierre, recupera la protección por lo del bot (%s)', async (_, added, shown) => {
    const r = await rig()
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 1 })
    await r.exchange.placeStopMarket(stopFor(145, 1))
    await r.exchange.placeTakeProfitMarket(stopFor(160, 1))
    await r.clock.advance(1_000)
    fake.trading.manualPosition(SOL, 2)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(3), WAIT)
    await reconciler(r).tick()

    laggingSnapshot()
    await reconciler(r).tick()
    laggingSnapshot()
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    await vi.waitFor(() => expect(solProtection()).toEqual([]), WAIT)

    if (added > 0) fake.trading.manualPosition(SOL, added)
    await r.clock.advance(10_000)
    const logger = createLogger({ level: 'silent' })
    const warn = vi.spyOn(logger, 'warn')
    await reconciler(r, { logger }).tick()
    expect(fake.trading.position(SOL)!.amount).toBe(shown)
    // Lo de más puede ser de Toti: queda a la vista en el log.
    expect(warn).toHaveBeenCalledWith({ symbol: SOL, amount: shown, botQty: 1 }, expect.stringMatching(/^Reconciler: volvió a aparecer con más que lo del bot/))
    expect(r.exchange.hasPendingClose(SOL)).toBe(false)
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '1'],
      ['TAKE_PROFIT_MARKET', '160.00', '1'],
    ])
    expect(r.notes.filter((n) => n.kind === 'reconciled').map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: volvió a aparecer; le repuse la protección. Lo corregí.'])
    // Vuelve a ser del bot: recibe órdenes otra vez.
    await r.exchange.placeStopMarket(stopFor(146, 1))
  })

  it('desaparecida sin trades todavía: no la protege ni la cierra hasta encontrar el cierre', async () => {
    const r = await rig()
    await solWithProtection(r)
    fake.holdUserEvents(true)
    fake.trading.manualPosition(SOL, -2)
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 200, body: [] }, 2)

    await reconciler(r).tick()
    expect(r.exchange.hasPendingClose(SOL)).toBe(false)
    const sent = fake.requests.filter((q) => q.method === 'POST').length
    await expect(r.exchange.placeStopMarket(stopFor(145, 2))).rejects.toThrow(/no muestra/)
    await expect(r.exchange.closePosition(SOL, 'signal_flip')).rejects.toThrow(/no muestra/)
    expect(await r.exchange.ensureProtected(SOL)).toBeNull()
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(sent)

    // La vuelta siguiente la confirma: sus algos se cancelan y sigue sin recibir órdenes.
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    await vi.waitFor(() => expect(solProtection()).toEqual([]), WAIT)
    await expect(r.exchange.closePosition(SOL, 'signal_flip')).rejects.toThrow(/ya no tiene/)

    // Con los trades a la vista, el cierre llega al motor.
    await reconciler(r).tick()
    expect(r.exchange.processTick(markTick(SOL, 150, r.clock.now()))).toMatchObject([{ reason: 'closed_on_exchange', fill: { qty: 2 } }])
    fake.holdUserEvents(false)
  })

  it('al arrancar, una desaparecida sin trades no recibe órdenes y la primera vuelta la confirma', async () => {
    const first = await rig()
    const opened = await openWithEngine(first)
    await shutdown(first)
    fake.trading.manualPosition(ETH, -opened.qty)
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 200, body: [] }, 2)

    let r = await rig(first.clock)
    const start = await reconcileAtStart(startDeps(r))
    expect(start.vanished).toEqual([ETH])
    r = withStart(r, start)
    const { engine } = realEngine(r, {})
    await engine.restore(restoredState(await t.repos.positions.listOpen(REAL_SESSION), r.clock.now()))
    await expect(r.exchange.placeStopMarket({ ...stopFor(1_900, opened.qty), symbol: ETH })).rejects.toThrow(/no muestra/)
    expect(live().filter((a) => a.symbol === ETH)).toHaveLength(2)
    // Los algos que dejó el bot no pueden quedar sobre lo que Toti abra en la moneda.
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    await vi.waitFor(() => expect(live().filter((a) => a.symbol === ETH)).toEqual([]), WAIT)
  })

  // Con más que lo del bot tampoco es suya: la moneda quedó en cero desde la apertura.
  it.each([1, 3])('desaparecida: cancela sus algos y sigue buscando el cierre aunque Toti abra %d del mismo lado', async (toti) => {
    const r = await rig()
    await solWithProtection(r)
    fake.holdUserEvents(true)
    fake.trading.manualPosition(SOL, -2)
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 200, body: [] }, 2)

    await reconciler(r).tick()
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    expect(r.exchange.hasPendingClose(SOL)).toBe(false)
    await vi.waitFor(() => expect(solProtection()).toEqual([]), WAIT)

    // Toti abre del mismo lado antes de que aparezcan los trades del cierre.
    fake.trading.manualPosition(SOL, toti)
    await reconciler(r).tick()
    expect(r.exchange.processTick(markTick(SOL, 150, r.clock.now()))).toMatchObject([{ reason: 'closed_on_exchange', fill: { qty: 2 } }])
    expect(solProtection()).toEqual([])
    expect(fake.trading.position(SOL)!.amount).toBe(toti)
    fake.holdUserEvents(false)
  })

  it('desaparecida que vuelve con menos que lo del bot: los trades se leen una sola vez por vuelta', async () => {
    const r = await rig()
    await solWithProtection(r)
    fake.holdUserEvents(true)
    fake.trading.manualPosition(SOL, -2)
    fake.failNext('/fapi/v1/userTrades', { method: 'GET', status: 200, body: [] }, 4)
    await reconciler(r).tick()
    await r.clock.advance(10_000)
    await reconciler(r).tick()
    await vi.waitFor(() => expect(solProtection()).toEqual([]), WAIT)

    fake.trading.manualPosition(SOL, 1)
    const trades = () => fake.requests.filter((q) => q.path === '/fapi/v1/userTrades').length
    const before = trades()
    await reconciler(r).tick()

    expect(trades() - before).toBe(1)
    expect(r.exchange.hasPendingClose(SOL)).toBe(false)
    expect(solProtection()).toEqual([])
    fake.holdUserEvents(false)
  })

  // ---------- Stop por otra cantidad ----------

  it('un stop que no se pudo achicar después de un cierre a medias se ajusta en la vuelta siguiente', async () => {
    const r = await rig()
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 4 })
    await r.exchange.placeStopMarket(stopFor(145, 4))
    fake.trading.manualPosition(SOL, 2)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(6), WAIT)
    fake.trading.partialFillNext(0.5)
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 3)
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toThrow(/cerré 2 de 4/)
    expect(solProtection()).toEqual([['STOP_MARKET', '145.00', '4']])

    await reconciler(r).tick()
    expect(solProtection()).toEqual([['STOP_MARKET', '145.00', '2']])
    expect(r.notes.filter((n) => n.kind === 'reconciled').map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: el stop no era por mis 2; lo ajusté. Lo corregí.'])
    // Con la cantidad del bot, otra vuelta no toca nada.
    const sent = fake.requests.filter((q) => q.method === 'POST').length
    await reconciler(r).tick()
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(sent)
  })

  it('un take profit que no se pudo achicar después de un cierre a medias se ajusta en la vuelta siguiente', async () => {
    const r = await rig()
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty: 4 })
    await r.exchange.placeStopMarket(stopFor(145, 4))
    await r.exchange.placeTakeProfitMarket(stopFor(160, 4))
    fake.trading.manualPosition(SOL, 2)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(6), WAIT)
    fake.trading.partialFillNext(0.5)
    // Binance no toma ni el stop ni el take profit achicados.
    fake.trading.rejectNext('/fapi/v1/algoOrder', -1001, undefined, 6)
    await expect(drive(r.clock, r.exchange.closePosition(SOL, 'signal_flip'))).rejects.toThrow(/cerré 2 de 4/)
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '4'],
      ['TAKE_PROFIT_MARKET', '160.00', '4'],
    ])

    await reconciler(r).tick()
    // Un take profit por 4 cerraría también lo de Toti.
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '2'],
      ['TAKE_PROFIT_MARKET', '160.00', '2'],
    ])
    expect(r.notes.filter((n) => n.kind === 'reconciled').map((n) => n.phrase)).toEqual([
      'Binance y yo no coincidíamos en SOL: el stop no era por mis 2; lo ajusté. Lo corregí.',
      'Binance y yo no coincidíamos en SOL: el take profit no era por mis 2; lo ajusté. Lo corregí.',
    ])
    const sent = fake.requests.filter((q) => q.method === 'POST').length
    await reconciler(r).tick()
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(sent)
  })

  it('un stop del bot por otra cantidad que sobra junto al bueno se cancela', async () => {
    const r = await rig()
    await solWithProtection(r)
    const extra = r.ids.next('s')
    await r.kit.trade.algoOrder({ symbol: SOL, side: 'SELL', type: 'STOP_MARKET', triggerPrice: '140', quantity: '4', clientAlgoId: extra })
    await vi.waitFor(() => expect(r.account.botAlgos(SOL)).toHaveLength(3), WAIT)

    await reconciler(r).tick()
    expect(solProtection()).toEqual([
      ['STOP_MARKET', '145.00', '2'],
      ['TAKE_PROFIT_MARKET', '160.00', '2'],
    ])
    expect(fake.trading.algos.find((a) => a.clientAlgoId === extra)!.algoStatus).toBe('CANCELED')
    expect(r.notes.map((n) => n.phrase)).toEqual(['Binance y yo no coincidíamos en SOL: sobraba un stop del bot por otra cantidad; lo cancelé. Lo corregí.'])
  })
})
