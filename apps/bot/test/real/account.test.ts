import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceHttpError, BinanceNetworkError } from '../../src/binance/errors'
import { FakeBinance } from '../../src/binance/fake/server'
import { classifyBinanceError } from '../../src/binance/trade-errors'
import type { AccountUpdate, AlgoOrder, AlgoUpdate, BinancePosition, OrderAck, OrderTradeUpdate, UserTrade } from '../../src/binance/trade-types'
import { UserDataStream, type UserDataStreamEvents } from '../../src/binance/user-stream'
import { realClock } from '../../src/live/timers'
import { RealAccount, type SyncSnapshot, type TradeApi, type TriggeredFill, type UserStreamLike } from '../../src/real/account'
import { ClientIds } from '../../src/real/client-id'
import { tradeFor, type TradeKit } from '../helpers/binance'
import { ManualClock } from '../helpers/manual-clock'

const SESSION = 'ses_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OTHER_SESSION_ALGO = 'sereno-ffffffff-s1'
const WAIT = { timeout: 2_000, interval: 5 }

describe('RealAccount contra el Binance falso', () => {
  let fake: FakeBinance
  let kit: TradeKit
  let account: RealAccount
  let ids: ClientIds

  const sum = (values: string[]): number => values.reduce((acc, v) => acc + Number(v), 0)
  const requestsTo = (path: string): number => fake.requests.filter((r) => r.path === path).length

  async function open(qty = '0.010'): Promise<string> {
    const id = ids.next('o')
    await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: qty, reduceOnly: false, clientOrderId: id })
    return id
  }

  async function stop(clientAlgoId = ids.next('s'), triggerPrice = '67000'): Promise<string> {
    await kit.trade.algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice, quantity: '0.010', clientAlgoId })
    return clientAlgoId
  }

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark('BTCUSDT', 68_000)
    kit = tradeFor(fake)
    const stream = new UserDataStream({ trade: kit.trade, url: fake.userWsUrl, clock: realClock, backoffBaseMs: 5, backoffMaxMs: 20 })
    account = new RealAccount({ trade: kit.trade, stream, sessionId: SESSION, clock: realClock })
    ids = new ClientIds(SESSION, Date.now)
    await account.start()
  })
  afterEach(async () => {
    await account.stop()
  })

  it('start conecta el stream y hace el primer sync', () => {
    expect(account.streamUp).toBe(true)
    expect(requestsTo('/fapi/v2/positionRisk')).toBe(1)
    expect(requestsTo('/fapi/v1/openAlgoOrders')).toBe(1)
  })

  it('sync ignora algos sin el prefijo de la sesión', async () => {
    await open()
    const ours = await stop()
    await stop(OTHER_SESSION_ALGO, '66000')
    await stop('manual_stop_1', '65000')

    const snapshot = await account.sync()
    expect(snapshot.botAlgos.map((a) => a.clientAlgoId)).toEqual([ours])
    expect(snapshot.positions.get('BTCUSDT')).toMatchObject({ amount: 0.01, entryPrice: 68_000, leverage: 20 })
    expect(snapshot.at).toBeGreaterThan(0)
    expect(account.botAlgos('BTCUSDT').map((a) => a.clientAlgoId)).toEqual([ours])
    expect(account.botAlgos().map((a) => a.clientAlgoId)).toEqual([ours])
    expect(account.botAlgos('SOLUSDT')).toEqual([])
  })

  it('awaitOrderFill arma el fill con dos parciales y el precio promedio ponderado', async () => {
    fake.trading.partialFillNext(0.5, { rest: 'fill', price: 68_100 })
    const id = await open()

    const fill = await account.awaitOrderFill('BTCUSDT', id, 2_000)
    expect(fill).toMatchObject({ clientOrderId: id, qty: 0.01, status: 'FILLED', realizedPnl: 0 })
    expect(fill.avgPrice).toBeCloseTo(68_050, 8)
    expect(fill.commission).toBeCloseTo(sum(fake.trading.trades.map((t) => t.commission)), 10)
    expect(fake.trading.trades).toHaveLength(2)
    expect(fill.at).toBeGreaterThan(0)
    // Salió del stream: no hizo falta preguntar.
    expect(requestsTo('/fapi/v1/userTrades')).toBe(0)
  })

  it('con el stream atrasado completa por userTrades al vencer el plazo', async () => {
    fake.holdUserEvents(true)
    fake.trading.partialFillNext(0.5, { rest: 'fill', price: 68_100 })
    const id = await open()

    const fill = await account.awaitOrderFill('BTCUSDT', id, 50)
    expect(fill).toMatchObject({ clientOrderId: id, qty: 0.01, status: 'FILLED', realizedPnl: 0 })
    expect(fill.avgPrice).toBeCloseTo(68_050, 8)
    expect(fill.commission).toBeCloseTo(sum(fake.trading.trades.map((t) => t.commission)), 10)
    const orderId = fake.trading.orders[0]!.orderId
    expect(fake.requests.find((r) => r.path === '/fapi/v1/userTrades')!.query).toMatchObject({ symbol: 'BTCUSDT', orderId: String(orderId) })
  })

  it('onTriggered llega con la comisión y el pnl realizado del falso', async () => {
    await open()
    const stopId = await stop()
    await account.sync()
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))

    fake.trading.setMark('BTCUSDT', 66_900)
    await vi.waitFor(() => expect(triggered).toHaveLength(1), WAIT)
    const closing = fake.trading.trades.at(-1)!
    expect(triggered[0]).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: stopId, liquidation: false })
    expect(triggered[0]!.fill).toMatchObject({ qty: 0.01, avgPrice: 66_900, status: 'FILLED', commission: Number(closing.commission), realizedPnl: Number(closing.realizedPnl) })
    expect(triggered[0]!.fill.realizedPnl).toBeCloseTo(-11, 8)
    await vi.waitFor(() => expect(account.position('BTCUSDT')).toBeNull(), WAIT)
    expect(account.botAlgos('BTCUSDT')).toEqual([])
  })

  it('una liquidación en una moneda con stop del bot llega como liquidation, a nombre del stop', async () => {
    await open()
    await kit.trade.algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', triggerPrice: '70000', quantity: '0.010', clientAlgoId: ids.next('t') })
    const stopId = await stop()
    await vi.waitFor(() => expect(account.botAlgos('BTCUSDT')).toHaveLength(2), WAIT)
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))

    fake.trading.liquidate('BTCUSDT')
    await vi.waitFor(() => expect(triggered).toHaveLength(1), WAIT)
    // Como en Binance, los algos vencieron antes de que llegara la orden de liquidación.
    const kinds = fake.trading.events.map((e) => (e.e === 'ALGO_UPDATE' ? `algo:${e.o.X}` : e.e === 'ORDER_TRADE_UPDATE' && e.o.c.startsWith('autoclose-') ? 'autoclose' : null)).filter((k) => k !== null)
    expect(kinds.slice(-4)).toEqual(['algo:EXPIRED', 'algo:EXPIRED', 'autoclose', 'autoclose'])
    expect(account.botAlgos('BTCUSDT')).toEqual([])
    expect(triggered[0]).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: stopId, liquidation: true })
    expect(triggered[0]!.fill.clientOrderId).toMatch(/^autoclose-/)
    expect(triggered[0]!.fill.realizedPnl).toBeCloseTo(Number(fake.trading.trades.at(-1)!.realizedPnl), 10)
  })

  it('la liquidación de una posición de Toti no se avisa', async () => {
    fake.trading.manualPosition('BTCUSDT', 0.01)
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    fake.trading.liquidate('BTCUSDT')
    await vi.waitFor(() => expect(account.position('BTCUSDT')).toBeNull(), WAIT)
    await new Promise((r) => setTimeout(r, 20))
    expect(triggered).toEqual([])
  })

  it('la posición viva sigue al stream entre syncs', async () => {
    await open()
    await vi.waitFor(() => expect(account.position('BTCUSDT')).not.toBeNull(), WAIT)
    // El apalancamiento no viaja en el stream: se sabe en el próximo sync.
    expect(account.position('BTCUSDT')).toMatchObject({ symbol: 'BTCUSDT', amount: 0.01, entryPrice: 68_000, markPrice: 68_000, marginType: 'cross', leverage: null, liquidationPrice: null })
    await account.sync()
    expect(account.position('BTCUSDT')).toMatchObject({ amount: 0.01, leverage: 20 })
    expect(account.position('BTCUSDT')!.liquidationPrice).not.toBeNull()

    await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: ids.next('o') })
    await vi.waitFor(() => expect(account.position('BTCUSDT')!.amount).toBe(0.02), WAIT)
    // La cantidad cambió: el precio de liquidación del último sync ya no vale.
    expect(account.position('BTCUSDT')).toMatchObject({ leverage: 20, liquidationPrice: null })

    await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.020', reduceOnly: true, clientOrderId: ids.next('c') })
    await vi.waitFor(() => expect(account.position('BTCUSDT')).toBeNull(), WAIT)
  })

  it('tras un corte sincroniza y avisa onResync con la foto', async () => {
    await open()
    const snapshots: SyncSnapshot[] = []
    account.onResync((s) => snapshots.push(s))

    fake.dropUserClients()
    await vi.waitFor(() => expect(snapshots).toHaveLength(1), WAIT)
    expect(snapshots[0]!.positions.get('BTCUSDT')).toMatchObject({ amount: 0.01 })
    expect(account.streamUp).toBe(true)
    expect(requestsTo('/fapi/v2/positionRisk')).toBe(2)
  })
})

// ---------- Con dobles: lo que el falso no deja provocar en el momento justo ----------

class StubStream implements UserStreamLike {
  connected = true
  starts = 0
  stops = 0
  private readonly handlers = new Map<string, Set<(...args: never[]) => void>>()

  on<K extends keyof UserDataStreamEvents>(event: K, handler: UserDataStreamEvents[K]): () => void {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler as (...args: never[]) => void)
    this.handlers.set(event, set)
    return () => set.delete(handler as (...args: never[]) => void)
  }

  start(): void {
    this.starts++
  }

  async stop(): Promise<void> {
    this.stops++
  }

  emit<K extends keyof UserDataStreamEvents>(event: K, ...args: Parameters<UserDataStreamEvents[K]>): void {
    for (const h of this.handlers.get(event) ?? []) (h as (...a: Parameters<UserDataStreamEvents[K]>) => void)(...args)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Las colas (`next…`) contestan primero, en orden; vacías, contesta el valor fijo.
class StubTrade implements TradeApi {
  positionRiskCalls = 0
  queryOrderCalls = 0
  nextPositions: Promise<BinancePosition[]>[] = []
  positions: BinancePosition[] = []
  algos: AlgoOrder[] = []
  nextAcks: (OrderAck | null)[] = []
  ack: OrderAck | null = null
  nextTrades: UserTrade[][] = []
  trades: UserTrade[] = []
  // Errores que contestan antes que las colas, en orden.
  queryErrors: unknown[] = []
  tradesErrors: unknown[] = []

  async positionRisk(): Promise<BinancePosition[]> {
    this.positionRiskCalls++
    return this.nextPositions.shift() ?? this.positions
  }

  async openAlgoOrders(): Promise<AlgoOrder[]> {
    return this.algos
  }

  async queryOrder(): Promise<OrderAck | null> {
    this.queryOrderCalls++
    if (this.queryErrors.length > 0) throw this.queryErrors.shift()
    return this.nextAcks.length > 0 ? this.nextAcks.shift()! : this.ack
  }

  async userTrades(): Promise<UserTrade[]> {
    if (this.tradesErrors.length > 0) throw this.tradesErrors.shift()
    return this.nextTrades.shift() ?? this.trades
  }
}

function position(symbol: string, amount: number): BinancePosition {
  return { symbol, amount, entryPrice: 100, markPrice: 100, liquidationPrice: 50, marginType: 'isolated', isolatedMargin: 10, leverage: 5 }
}

function accountUpdate(symbol: string, amount: number): AccountUpdate {
  return { reason: 'ORDER', at: 1, positions: [{ symbol, amount, entryPrice: 100, marginType: 'isolated', isolatedMargin: 10, unrealizedPnl: 0 }] }
}

function orderUpdate(patch: Partial<OrderTradeUpdate>): OrderTradeUpdate {
  return {
    symbol: 'BTCUSDT',
    clientOrderId: 'sereno-0a1b2c3d-o1',
    orderId: 7,
    side: 'SELL',
    origType: 'MARKET',
    status: 'FILLED',
    execType: 'TRADE',
    lastQty: 1,
    lastPrice: 100,
    avgPrice: 100,
    cumQty: 1,
    commission: 0.05,
    commissionAsset: 'USDT',
    realizedPnl: 2,
    reduceOnly: true,
    at: 1,
    liquidation: false,
    ...patch,
  }
}

function ack(patch: Partial<OrderAck>): OrderAck {
  return { symbol: 'BTCUSDT', orderId: 7, clientOrderId: 'sereno-0a1b2c3d-o1', status: 'FILLED', executedQty: 1, avgPrice: 104, updateTime: 9, ...patch }
}

function userTrade(patch: Partial<UserTrade>): UserTrade {
  return { id: 1, orderId: 7, symbol: 'BTCUSDT', side: 'SELL', price: 100, qty: 1, commission: 0.05, commissionAsset: 'USDT', realizedPnl: 2, time: 9, ...patch }
}

function liquidationOrder(orderId: number): OrderTradeUpdate {
  return orderUpdate({ orderId, clientOrderId: `autoclose-${orderId}`, liquidation: true })
}

function algoUpdate(patch: Partial<AlgoUpdate>): AlgoUpdate {
  return { symbol: 'BTCUSDT', clientAlgoId: 'sereno-0a1b2c3d-s1', algoId: 3, type: 'STOP_MARKET', side: 'SELL', triggerPrice: 95, quantity: 1, status: 'NEW', triggeredOrderId: null, at: 1, ...patch }
}

describe('RealAccount con dobles', () => {
  let stream: StubStream
  let trade: StubTrade
  let clock: ManualClock
  let account: RealAccount

  beforeEach(() => {
    stream = new StubStream()
    trade = new StubTrade()
    clock = new ManualClock(Date.UTC(2026, 10, 1, 12))
    account = new RealAccount({ trade, stream, sessionId: SESSION, clock })
  })

  it('un evento que llega durante el sync gana sobre la foto de REST', async () => {
    const rest = deferred<BinancePosition[]>()
    trade.nextPositions = [rest.promise]
    const syncing = account.sync()
    // Mientras REST contesta, el stream cierra BTC y abre ETH.
    stream.emit('account', accountUpdate('BTCUSDT', 0))
    stream.emit('account', accountUpdate('ETHUSDT', 2))
    rest.resolve([position('BTCUSDT', 1), position('SOLUSDT', 3)])
    const snapshot = await syncing

    expect(snapshot.positions.get('BTCUSDT')).toMatchObject({ amount: 1 })
    expect(account.position('BTCUSDT')).toBeNull()
    expect(account.position('ETHUSDT')).toMatchObject({ amount: 2 })
    expect(account.position('SOLUSDT')).toMatchObject({ amount: 3, leverage: 5, liquidationPrice: 50 })

    // El próximo sync, sin eventos en el medio, manda REST.
    trade.positions = [position('BTCUSDT', 1)]
    await account.sync()
    expect(account.position('BTCUSDT')).toMatchObject({ amount: 1 })
    expect(account.position('ETHUSDT')).toBeNull()
  })

  it('un algo que cambia durante el sync gana sobre la foto de REST', async () => {
    const rest = deferred<BinancePosition[]>()
    trade.nextPositions = [rest.promise]
    trade.algos = [{ symbol: 'BTCUSDT', clientAlgoId: 'sereno-0a1b2c3d-s1', algoId: 3, type: 'STOP_MARKET', side: 'SELL', triggerPrice: 95, quantity: 1, status: 'NEW', actualOrderId: null }]
    const syncing = account.sync()
    stream.emit('algo', algoUpdate({ status: 'CANCELED' }))
    rest.resolve([])
    const snapshot = await syncing
    expect(snapshot.botAlgos).toHaveLength(1)
    expect(account.botAlgos()).toEqual([])
  })

  it('un sync viejo que contesta último no pisa la foto de uno más nuevo', async () => {
    const older = deferred<BinancePosition[]>()
    const newer = deferred<BinancePosition[]>()
    trade.nextPositions = [older.promise, newer.promise]
    const first = account.sync()
    const second = account.sync()
    newer.resolve([position('BTCUSDT', 2)])
    await second
    older.resolve([position('BTCUSDT', 1), position('ETHUSDT', 1)])
    // Quien pidió el viejo recibe su foto, pero la cuenta se queda con la nueva.
    expect((await first).positions.get('BTCUSDT')).toMatchObject({ amount: 1 })
    expect(account.position('BTCUSDT')).toMatchObject({ amount: 2 })
    expect(account.position('ETHUSDT')).toBeNull()
  })

  it('el fill que llegó antes de pedirlo se devuelve en el acto', async () => {
    stream.emit('order', orderUpdate({ status: 'PARTIALLY_FILLED', lastQty: 0.4, cumQty: 0.4, avgPrice: 100, commission: 0.02, realizedPnl: 0.8 }))
    stream.emit('order', orderUpdate({ status: 'FILLED', lastQty: 0.6, lastPrice: 110, cumQty: 1, avgPrice: 106, commission: 0.03, realizedPnl: 1.2, at: 5 }))
    const fill = await account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 3_000)
    expect(fill).toMatchObject({ clientOrderId: 'sereno-0a1b2c3d-o1', qty: 1, avgPrice: 106, status: 'FILLED', at: 5 })
    expect(fill.commission).toBeCloseTo(0.05, 12)
    expect(fill.realizedPnl).toBeCloseTo(2, 12)
    expect(clock.timerCount).toBe(0)
  })

  it('una orden que vence sin llenarse entrega cantidad 0 y su estado', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 3_000)
    stream.emit('order', orderUpdate({ status: 'EXPIRED', execType: 'EXPIRED', lastQty: 0, lastPrice: 0, cumQty: 0, avgPrice: 0, commission: 0, commissionAsset: null, realizedPnl: 0 }))
    await expect(waiting).resolves.toMatchObject({ qty: 0, avgPrice: 0, commission: 0, status: 'EXPIRED' })
  })

  it('una comisión en otra moneda es un error fatal', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 3_000)
    stream.emit('order', orderUpdate({ commissionAsset: 'BNB', commission: 0.0001 }))
    const err = await waiting.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/BNB/)
    expect(classifyBinanceError(err).kind).toBe('fatal')
  })

  it('por REST también: una comisión en otra moneda es fatal', async () => {
    trade.ack = ack({ avgPrice: 100 })
    trade.trades = [userTrade({ commission: 0.0001, commissionAsset: 'BNB' })]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 3_000).catch((e: unknown) => e)
    await clock.advance(3_000)
    expect(classifyBinanceError(await waiting).kind).toBe('fatal')
  })

  it('por REST: una orden que Binance no tiene es un error', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o9', 1_000).catch((e: unknown) => e)
    await clock.advance(1_000)
    expect(((await waiting) as Error).message).toMatch(/sereno-0a1b2c3d-o9/)
  })

  it('por REST: cantidad y precio de la orden; comisión y pnl de sus trades', async () => {
    trade.ack = { symbol: 'BTCUSDT', orderId: 7, clientOrderId: 'sereno-0a1b2c3d-o1', status: 'FILLED', executedQty: 1, avgPrice: 104, updateTime: 9 }
    trade.trades = [
      { id: 1, orderId: 7, symbol: 'BTCUSDT', side: 'SELL', price: 100, qty: 0.6, commission: 0.03, commissionAsset: 'USDT', realizedPnl: 1, time: 8 },
      { id: 2, orderId: 7, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 0.4, commission: 0.02, commissionAsset: 'USDT', realizedPnl: 1.5, time: 9 },
    ]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(1_000)
    const fill = await waiting
    expect(fill).toMatchObject({ qty: 1, avgPrice: 104, status: 'FILLED', at: 9 })
    expect(fill.commission).toBeCloseTo(0.05, 12)
    expect(fill.realizedPnl).toBeCloseTo(2.5, 12)
  })

  it('por REST: si la orden todavía no está final, vuelve a preguntar', async () => {
    trade.nextAcks = [ack({ status: 'NEW', executedQty: 0, avgPrice: 0 })]
    trade.ack = ack({})
    trade.trades = [userTrade({})]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(1_000)
    expect(trade.queryOrderCalls).toBe(1)
    await clock.advance(1_000)
    await expect(waiting).resolves.toMatchObject({ qty: 1, status: 'FILLED', commission: 0.05 })
    expect(trade.queryOrderCalls).toBe(2)
  })

  it('por REST: si userTrades todavía no trae todos los trades, vuelve a preguntar', async () => {
    trade.ack = ack({})
    trade.nextTrades = [[userTrade({ qty: 0.6, commission: 0.03, realizedPnl: 1 })]]
    trade.trades = [userTrade({ qty: 0.6, commission: 0.03, realizedPnl: 1 }), userTrade({ id: 2, price: 110, qty: 0.4, commission: 0.02, realizedPnl: 1.5 })]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(2_000)
    const fill = await waiting
    expect(fill.commission).toBeCloseTo(0.05, 12)
    expect(fill.realizedPnl).toBeCloseTo(2.5, 12)
    expect(trade.queryOrderCalls).toBe(2)
  })

  it('por REST: agotados los reintentos devuelve lo que hay, con su estado', async () => {
    trade.ack = ack({ status: 'PARTIALLY_FILLED', executedQty: 0.4 })
    trade.trades = [userTrade({ qty: 0.4, commission: 0.02 })]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(10_000)
    await expect(waiting).resolves.toMatchObject({ qty: 0.4, status: 'PARTIALLY_FILLED', commission: 0.02 })
    expect(trade.queryOrderCalls).toBe(3)
    expect(clock.timerCount).toBe(0)
  })

  it('por REST: un error pasajero de Binance se reintenta dentro del presupuesto', async () => {
    trade.queryErrors = [new BinanceNetworkError('socket hang up', '/fapi/v1/order')]
    trade.tradesErrors = [new BinanceHttpError('Internal error', { status: 500, path: '/fapi/v1/userTrades' })]
    trade.ack = ack({})
    trade.trades = [userTrade({})]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(3_000)
    await expect(waiting).resolves.toMatchObject({ qty: 1, status: 'FILLED', commission: 0.05, complete: true, orderId: 7 })
    expect(trade.queryOrderCalls).toBe(3)
  })

  it('por REST: si los errores pasajeros agotan el presupuesto, la espera falla con el último', async () => {
    const down = (): BinanceNetworkError => new BinanceNetworkError('socket hang up', '/fapi/v1/order')
    trade.queryErrors = [down(), down(), down()]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000).catch((e: unknown) => e)
    await clock.advance(10_000)
    expect(await waiting).toBeInstanceOf(BinanceNetworkError)
    expect(trade.queryOrderCalls).toBe(3)
    expect(clock.timerCount).toBe(0)
  })

  it('por REST: una orden FILLED cuyos trades no suman lo ejecutado llega marcada incompleta', async () => {
    trade.ack = ack({})
    trade.trades = [userTrade({ qty: 0.6, commission: 0.03 })]
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(10_000)
    await expect(waiting).resolves.toMatchObject({ qty: 1, status: 'FILLED', commission: 0.03, complete: false })
  })

  it('el fill del stream llega completo y con el id de la orden', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    stream.emit('order', orderUpdate({}))
    await expect(waiting).resolves.toMatchObject({ complete: true, orderId: 7 })
  })

  it('una orden con una espera pendiente no se olvida aunque pase el plazo de retención', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 30 * 60_000)
    stream.emit('order', orderUpdate({ status: 'PARTIALLY_FILLED', lastQty: 0.4, cumQty: 0.4, commission: 0.02, realizedPnl: 0 }))
    await clock.advance(11 * 60_000)
    // Otra orden cualquiera hace que el registro pode lo viejo.
    stream.emit('order', orderUpdate({ orderId: 99, clientOrderId: 'web_1', status: 'NEW', execType: 'NEW', lastQty: 0, cumQty: 0, commission: 0, commissionAsset: null }))
    stream.emit('order', orderUpdate({ lastQty: 0.6, cumQty: 1, commission: 0.03, realizedPnl: 0 }))
    const fill = await waiting
    expect(fill.qty).toBe(1)
    expect(fill.commission).toBeCloseTo(0.05, 12)
  })

  it('si el stream se pone al día durante los reintentos por REST, gana el stream', async () => {
    trade.ack = ack({ status: 'NEW', executedQty: 0, avgPrice: 0 })
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 1_000)
    await clock.advance(1_000)
    stream.emit('order', orderUpdate({}))
    await expect(waiting).resolves.toMatchObject({ qty: 1, status: 'FILLED', commission: 0.05 })
    await clock.advance(10_000)
    expect(trade.queryOrderCalls).toBe(1)
  })

  it('una liquidación vincula el stop que Binance acaba de cancelar al liquidar', () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    const takeProfit = { clientAlgoId: 'sereno-0a1b2c3d-t1', algoId: 4, type: 'TAKE_PROFIT_MARKET' as const, triggerPrice: 120 }
    stream.emit('algo', algoUpdate(takeProfit))
    stream.emit('algo', algoUpdate({}))
    // Binance cancela primero las órdenes abiertas de la moneda y después liquida.
    stream.emit('algo', algoUpdate({ ...takeProfit, status: 'EXPIRED' }))
    stream.emit('algo', algoUpdate({ status: 'EXPIRED' }))
    expect(account.botAlgos()).toEqual([])
    stream.emit('order', liquidationOrder(50))
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: 'sereno-0a1b2c3d-s1', liquidation: true, fill: { clientOrderId: 'autoclose-50', qty: 1 } })
  })

  it('una liquidación prefiere el stop que Binance dio de baja más recientemente', async () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    // Un stop de una posición anterior, cancelado hace 30 s.
    stream.emit('algo', algoUpdate({ clientAlgoId: 'sereno-0a1b2c3d-s1', algoId: 3 }))
    stream.emit('algo', algoUpdate({ clientAlgoId: 'sereno-0a1b2c3d-s1', algoId: 3, status: 'CANCELED' }))
    await clock.advance(30_000)
    stream.emit('algo', algoUpdate({ clientAlgoId: 'sereno-0a1b2c3d-s2', algoId: 5 }))
    stream.emit('algo', algoUpdate({ clientAlgoId: 'sereno-0a1b2c3d-s2', algoId: 5, status: 'EXPIRED' }))
    stream.emit('order', liquidationOrder(50))
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ clientAlgoId: 'sereno-0a1b2c3d-s2', liquidation: true })
  })

  it('un stop cancelado hace más de un minuto no reclama una liquidación', async () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    stream.emit('algo', algoUpdate({}))
    stream.emit('algo', algoUpdate({ status: 'CANCELED' }))
    await clock.advance(60_001)
    stream.emit('order', liquidationOrder(50))
    expect(triggered).toEqual([])
  })

  it('un stop que ya disparó no reclama una liquidación posterior', () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    stream.emit('algo', algoUpdate({}))
    stream.emit('algo', algoUpdate({ status: 'TRIGGERED', triggeredOrderId: 40 }))
    stream.emit('order', orderUpdate({ orderId: 40, clientOrderId: 'algo_3', origType: 'STOP_MARKET' }))
    stream.emit('algo', algoUpdate({ status: 'FINISHED', triggeredOrderId: 40 }))
    stream.emit('order', liquidationOrder(50))
    expect(triggered.map((t) => t.liquidation)).toEqual([false])
  })

  it('un disparo con comisión en otra moneda avisa por onFatal y no por onTriggered', () => {
    const fatal: Error[] = []
    const triggered: TriggeredFill[] = []
    account.onFatal((e) => fatal.push(e))
    account.onTriggered((t) => triggered.push(t))
    stream.emit('algo', algoUpdate({ status: 'TRIGGERED', triggeredOrderId: 40 }))
    stream.emit('order', orderUpdate({ orderId: 40, clientOrderId: 'algo_3', origType: 'STOP_MARKET', commissionAsset: 'BNB' }))
    expect(triggered).toEqual([])
    expect(fatal).toHaveLength(1)
    expect(classifyBinanceError(fatal[0]).kind).toBe('fatal')
  })

  it('vincula el disparo aunque la orden llegue antes que el ALGO_UPDATE, y avisa una sola vez', () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    stream.emit('order', orderUpdate({ orderId: 40, clientOrderId: 'algo_3', origType: 'STOP_MARKET' }))
    expect(triggered).toEqual([])
    stream.emit('algo', algoUpdate({ status: 'TRIGGERED', triggeredOrderId: 40 }))
    stream.emit('algo', algoUpdate({ status: 'FINISHED', triggeredOrderId: 40 }))
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: 'sereno-0a1b2c3d-s1', liquidation: false, fill: { clientOrderId: 'algo_3', qty: 1 } })
  })

  it('el disparo de un algo de otra sesión no se avisa', () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    stream.emit('algo', algoUpdate({ clientAlgoId: OTHER_SESSION_ALGO, status: 'TRIGGERED', triggeredOrderId: 40 }))
    stream.emit('order', orderUpdate({ orderId: 40, clientOrderId: 'algo_3' }))
    expect(triggered).toEqual([])
  })

  it('un disparo que vence sin llenar no se avisa', () => {
    const triggered: TriggeredFill[] = []
    account.onTriggered((t) => triggered.push(t))
    stream.emit('algo', algoUpdate({ status: 'TRIGGERED', triggeredOrderId: 40 }))
    stream.emit('order', orderUpdate({ orderId: 40, clientOrderId: 'algo_3', status: 'EXPIRED', execType: 'EXPIRED', lastQty: 0, cumQty: 0, commission: 0, commissionAsset: null }))
    expect(triggered).toEqual([])
  })

  it('stop corta las esperas pendientes', async () => {
    const waiting = account.awaitOrderFill('BTCUSDT', 'sereno-0a1b2c3d-o1', 3_000).catch((e: unknown) => e)
    await account.stop()
    expect(((await waiting) as Error).message).toMatch(/detuvo/)
    expect(stream.stops).toBe(1)
    expect(clock.timerCount).toBe(0)
  })

  it('si el stream no conecta a tiempo, start sincroniza igual y vuelve a sincronizar al conectar', async () => {
    stream.connected = false
    const snapshots: SyncSnapshot[] = []
    account.onResync((s) => snapshots.push(s))
    const starting = account.start()
    expect(stream.starts).toBe(1)
    await clock.advance(10_000)
    await starting
    expect(trade.positionRiskCalls).toBe(1)
    expect(account.streamUp).toBe(false)

    stream.connected = true
    stream.emit('status', 'connected')
    // El stream también pide resync (su primer intento falló): se junta con el de la cuenta.
    stream.emit('resync')
    await vi.waitFor(() => expect(snapshots).toHaveLength(1), WAIT)
    await clock.advance(0)
    expect(trade.positionRiskCalls).toBe(2)
  })

  it('start espera la conexión antes del primer sync', async () => {
    stream.connected = false
    const starting = account.start()
    await clock.advance(1_000)
    expect(trade.positionRiskCalls).toBe(0)
    stream.connected = true
    stream.emit('status', 'connected')
    await starting
    expect(trade.positionRiskCalls).toBe(1)
    expect(clock.timerCount).toBe(0)
  })

  it('pedidos de resync encimados se juntan: uno en curso y uno más al terminar', async () => {
    const rest = deferred<BinancePosition[]>()
    trade.nextPositions = [rest.promise]
    const snapshots: SyncSnapshot[] = []
    account.onResync((s) => snapshots.push(s))
    // Dos pedidos juntos: un solo sync los cubre.
    stream.emit('resync')
    stream.emit('resync')
    await vi.waitFor(() => expect(trade.positionRiskCalls).toBe(1), WAIT)
    // Los que llegan con el sync en curso piden uno más, uno solo.
    stream.emit('resync')
    stream.emit('resync')
    rest.resolve([])
    await vi.waitFor(() => expect(snapshots).toHaveLength(2), WAIT)
    expect(trade.positionRiskCalls).toBe(2)
  })
})
