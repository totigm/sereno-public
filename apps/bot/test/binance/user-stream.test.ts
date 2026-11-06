import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMISSION_RATE } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { fakeSocketFactory } from '../../src/binance/fake/socket'
import type { AccountUpdate, AlgoUpdate, OrderTradeUpdate } from '../../src/binance/trade-types'
import { UserDataStream, type UserDataStreamOptions, type UserStreamStatus } from '../../src/binance/user-stream'
import { realClock } from '../../src/live/timers'
import { createLogger } from '../../src/logger'
import { tradeFor, type TradeKit } from '../helpers/binance'
import { logSink } from '../helpers/log-sink'
import { ManualClock } from '../helpers/manual-clock'

const LISTEN_KEY = '/fapi/v1/listenKey'
const BOT = 'sereno-0a1b2c3d-'
const MIN = 60_000
const TAKER = Number(COMMISSION_RATE.takerCommissionRate)

interface Recorded {
  orders: OrderTradeUpdate[]
  algos: AlgoUpdate[]
  accounts: AccountUpdate[]
  statuses: UserStreamStatus[]
  resyncs: number
}

describe('UserDataStream contra el Binance falso', () => {
  let fake: FakeBinance
  let kit: TradeKit
  let stream: UserDataStream | null
  let seen: Recorded

  const listenKeyCalls = (method: string): number => fake.requests.filter((r) => r.path === LISTEN_KEY && r.method === method).length

  function open(overrides: Partial<UserDataStreamOptions> = {}): UserDataStream {
    seen = { orders: [], algos: [], accounts: [], statuses: [], resyncs: 0 }
    const s = new UserDataStream({ trade: kit.trade, url: fake.userWsUrl, clock: realClock, backoffBaseMs: 5, backoffMaxMs: 20, ...overrides })
    s.on('order', (u) => seen.orders.push(u))
    s.on('algo', (u) => seen.algos.push(u))
    s.on('account', (u) => seen.accounts.push(u))
    s.on('status', (st) => seen.statuses.push(st))
    s.on('resync', () => seen.resyncs++)
    stream = s
    return s
  }

  async function connected(s: UserDataStream): Promise<void> {
    await vi.waitFor(() => expect(s.connected).toBe(true), { timeout: 2_000, interval: 5 })
  }

  async function openPosition(): Promise<void> {
    await kit.trade.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.010', reduceOnly: false, clientOrderId: `${BOT}o1` })
  }

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    fake.trading.setMark('BTCUSDT', 68_000)
    kit = tradeFor(fake)
    stream = null
  })
  afterEach(async () => {
    await stream?.stop()
  })

  it('un stop que dispara en el falso llega como algo TRIGGERED y order FILLED vinculadas', async () => {
    const s = open()
    s.start()
    await connected(s)
    await openPosition()
    await kit.trade.algoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '67000', quantity: '0.010', clientAlgoId: `${BOT}s1` })
    fake.trading.setMark('BTCUSDT', 66_900)

    await vi.waitFor(() => expect(seen.algos.map((a) => a.status)).toContain('FINISHED'), { timeout: 2_000, interval: 5 })
    const triggered = seen.algos.find((a) => a.status === 'TRIGGERED')
    expect(triggered).toMatchObject({ symbol: 'BTCUSDT', clientAlgoId: `${BOT}s1`, type: 'STOP_MARKET', side: 'SELL', triggerPrice: 67_000, quantity: 0.01 })
    const filled = seen.orders.find((o) => o.status === 'FILLED' && o.origType === 'STOP_MARKET')
    expect(filled).toBeDefined()
    expect(triggered!.triggeredOrderId).toBe(filled!.orderId)
    expect(filled).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', execType: 'TRADE', lastQty: 0.01, lastPrice: 66_900, avgPrice: 66_900, cumQty: 0.01, commissionAsset: 'USDT', reduceOnly: true, liquidation: false })
    expect(filled!.commission).toBeCloseTo(0.01 * 66_900 * TAKER, 10)
    expect(filled!.realizedPnl).toBeCloseTo(0.01 * (66_900 - 68_000), 10)
    // Antes de disparar el algo no tiene orden vinculada.
    expect(seen.algos.find((a) => a.status === 'NEW')!.triggeredOrderId).toBeNull()
    // La posición cerrada llega en cero.
    expect(seen.accounts.at(-1)).toMatchObject({ reason: 'ORDER', positions: [{ symbol: 'BTCUSDT', amount: 0 }] })
  })

  it('normaliza el ACCOUNT_UPDATE de una apertura', async () => {
    const s = open()
    s.start()
    await connected(s)
    await openPosition()
    await vi.waitFor(() => expect(seen.accounts).toHaveLength(1), { timeout: 2_000, interval: 5 })
    expect(seen.accounts[0]).toMatchObject({ reason: 'ORDER', positions: [{ symbol: 'BTCUSDT', amount: 0.01, entryPrice: 68_000, marginType: 'cross', isolatedMargin: 0, unrealizedPnl: 0 }] })
    expect(seen.accounts[0]!.at).toBeGreaterThan(0)
    const order = seen.orders.find((o) => o.clientOrderId === `${BOT}o1` && o.status === 'FILLED')
    expect(order).toMatchObject({ origType: 'MARKET', reduceOnly: false, liquidation: false })
    // El NEW todavía no tiene trade: sin comisión.
    expect(seen.orders.find((o) => o.status === 'NEW')).toMatchObject({ execType: 'NEW', lastQty: 0, commission: 0, commissionAsset: null })
  })

  it('si un handler tira, el log dice cuál y nada del evento (ni el listenKey)', async () => {
    const sink = logSink()
    const s = open({ logger: createLogger({ level: 'error', destination: sink.stream }) })
    s.on('account', () => {
      throw new Error('el handler falló')
    })
    s.start()
    await connected(s)
    await openPosition()
    await vi.waitFor(() => expect(sink.lines().length).toBeGreaterThan(0), { timeout: 2_000, interval: 5 })
    const [line] = sink.lines()
    expect(line).toMatchObject({ msg: 'UserDataStream: un handler lanzó una excepción', listener: 'account', err: { message: 'el handler falló' } })
    expect(Object.keys(line!).sort()).toEqual(['err', 'hostname', 'level', 'listener', 'msg', 'name', 'pid', 'time'])
    expect(JSON.stringify(line)).not.toContain(fake.trading.listenKey!)
  })

  it('renueva el listenKey cada 30 minutos', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 1, 12))
    const s = open({ clock, staleAfterMs: 24 * 60 * MIN })
    s.start()
    await connected(s)
    expect(listenKeyCalls('POST')).toBe(1)

    await clock.advance(29 * MIN)
    expect(listenKeyCalls('PUT')).toBe(0)
    await clock.advance(MIN)
    await vi.waitFor(() => expect(listenKeyCalls('PUT')).toBe(1), { timeout: 2_000, interval: 5 })
    await clock.advance(30 * MIN)
    await vi.waitFor(() => expect(listenKeyCalls('PUT')).toBe(2), { timeout: 2_000, interval: 5 })
    // Renovar no corta la conexión ni pide otro listenKey.
    expect(listenKeyCalls('POST')).toBe(1)
    expect(fake.userConnections).toHaveLength(1)
    expect(seen.resyncs).toBe(0)
  })

  it('reconecta y pide resync tras un corte', async () => {
    const s = open()
    s.start()
    await connected(s)
    expect(seen.statuses).toEqual(['connected'])
    // La primera conexión no pide resync: quien arranca hace su propia sincronización.
    expect(seen.resyncs).toBe(0)

    fake.dropUserClients()
    await vi.waitFor(() => expect(seen.resyncs).toBe(1), { timeout: 2_000, interval: 5 })
    expect(seen.statuses).toEqual(['connected', 'reconnecting', 'connected'])
    expect(s.connected).toBe(true)
    // Después del corte los eventos siguen llegando por la conexión nueva.
    await openPosition()
    await vi.waitFor(() => expect(seen.orders.some((o) => o.status === 'FILLED')).toBe(true), { timeout: 2_000, interval: 5 })
  })

  it('listenKeyExpired crea otro y pide resync', async () => {
    const s = open()
    s.start()
    await connected(s)
    const first = fake.trading.listenKey

    fake.expireListenKey()
    await vi.waitFor(() => expect(seen.resyncs).toBe(1), { timeout: 2_000, interval: 5 })
    expect(listenKeyCalls('POST')).toBe(2)
    expect(fake.trading.listenKey).not.toBe(first)
    expect(fake.userConnections.at(-1)!.listenKey).toBe(fake.trading.listenKey)
    expect(s.connected).toBe(true)
    await openPosition()
    await vi.waitFor(() => expect(seen.orders.some((o) => o.status === 'FILLED')).toBe(true), { timeout: 2_000, interval: 5 })
  })

  it('una liquidación se marca liquidation', async () => {
    const s = open()
    s.start()
    await connected(s)
    await openPosition()
    fake.trading.liquidate('BTCUSDT')

    await vi.waitFor(() => expect(seen.orders.some((o) => o.liquidation && o.status === 'FILLED')).toBe(true), { timeout: 2_000, interval: 5 })
    const liquidation = seen.orders.find((o) => o.liquidation && o.status === 'FILLED')!
    expect(liquidation.clientOrderId).toMatch(/^autoclose-/)
    expect(liquidation).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', cumQty: 0.01 })
    expect(liquidation.realizedPnl).toBeLessThan(0)
    expect(seen.orders.filter((o) => o.clientOrderId === `${BOT}o1`).every((o) => !o.liquidation)).toBe(true)
    expect(fake.trading.position('BTCUSDT')).toBeNull()
  })

  it('holdUserEvents retiene los eventos y los entrega en orden al soltarlos', async () => {
    const s = open()
    s.start()
    await connected(s)
    fake.holdUserEvents(true)
    await openPosition()
    await new Promise((r) => setTimeout(r, 30))
    expect(seen.orders).toHaveLength(0)

    fake.holdUserEvents(false)
    await vi.waitFor(() => expect(seen.accounts).toHaveLength(1), { timeout: 2_000, interval: 5 })
    expect(seen.orders.map((o) => o.status)).toEqual(['NEW', 'FILLED'])
  })

  it('si no puede crear el listenKey reintenta con backoff y, al conectar, pide resync', async () => {
    fake.failNext(LISTEN_KEY, { method: 'POST', status: 503, body: { code: -1000, msg: 'Service Unavailable.' } })
    const s = open()
    s.start()
    await connected(s)
    expect(listenKeyCalls('POST')).toBe(2)
    // Pudo haberse perdido algo mientras no había conexión.
    expect(seen.resyncs).toBe(1)
  })

  it('una renovación con −1125 crea otro listenKey, reconecta y pide resync', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 1, 12))
    const s = open({ clock, staleAfterMs: 24 * 60 * MIN })
    s.start()
    await connected(s)
    // Binance lo dio por vencido sin avisar por el stream.
    fake.trading.listenKey = null

    await clock.advance(30 * MIN)
    await vi.waitFor(() => expect(listenKeyCalls('POST')).toBe(2), { timeout: 2_000, interval: 5 })
    await vi.waitFor(() => expect(seen.resyncs).toBe(1), { timeout: 2_000, interval: 5 })
    expect(s.connected).toBe(true)
    expect(fake.userConnections.at(-1)!.listenKey).toBe(fake.trading.listenKey)
  })

  it('una renovación que falla por la red se reintenta sin reconectar', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 1, 12))
    const s = open({ clock, staleAfterMs: 24 * 60 * MIN, backoffMaxMs: MIN })
    s.start()
    await connected(s)
    fake.failNext(LISTEN_KEY, { method: 'PUT', status: 503, body: { code: -1000, msg: 'Service Unavailable.' } })

    await clock.advance(30 * MIN)
    await vi.waitFor(() => expect(listenKeyCalls('PUT')).toBe(1), { timeout: 2_000, interval: 5 })
    await clock.advance(MIN)
    await vi.waitFor(() => expect(listenKeyCalls('PUT')).toBe(2), { timeout: 2_000, interval: 5 })
    expect(listenKeyCalls('POST')).toBe(1)
    expect(seen.statuses).toEqual(['connected'])
  })

  it('sin pings ni mensajes del servidor da la conexión por muerta y reconecta', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 1, 12))
    const s = open({ clock, staleAfterMs: 10 * MIN })
    s.start()
    await connected(s)

    // Los pings del servidor (cada 3 min en Binance) la mantienen viva.
    for (let i = 0; i < 4; i++) {
      fake.pingClients()
      await vi.waitFor(() => expect(fake.userPongs).toBe(i + 1), { timeout: 2_000, interval: 5 })
      await clock.advance(3 * MIN)
    }
    expect(seen.statuses).toEqual(['connected'])

    await clock.advance(10 * MIN)
    await vi.waitFor(() => expect(seen.statuses).toContain('reconnecting'), { timeout: 2_000, interval: 5 })
    // El backoff corre en el reloj manual.
    await clock.advance(1_000)
    await vi.waitFor(() => expect(seen.resyncs).toBe(1), { timeout: 2_000, interval: 5 })
    expect(seen.statuses).toEqual(['connected', 'reconnecting', 'connected'])
  })

  it('stop cierra la conexión y el listenKey y no reconecta', async () => {
    const s = open()
    s.start()
    await connected(s)
    await s.stop()
    expect(s.connected).toBe(false)
    expect(seen.statuses).toEqual(['connected', 'closed'])
    expect(listenKeyCalls('DELETE')).toBe(1)
    expect(fake.trading.listenKey).toBeNull()
    await new Promise((r) => setTimeout(r, 40))
    expect(listenKeyCalls('POST')).toBe(1)
  })
})

describe('UserDataStream: mensajes', () => {
  const trade = {
    listenKeyCreate: async (): Promise<string> => 'clave-de-escucha',
    listenKeyKeepAlive: async (): Promise<void> => {},
    listenKeyClose: async (): Promise<void> => {},
  }

  it('ignora lo que no es JSON y los eventos que no conoce, y sigue entregando', async () => {
    const factory = fakeSocketFactory()
    const s = new UserDataStream({ trade, url: 'wss://fstream.binance.com/private/ws/', WebSocket: factory.WebSocket, clock: realClock })
    const orders: OrderTradeUpdate[] = []
    s.on('order', (u) => orders.push(u))
    s.start()
    await vi.waitFor(() => expect(factory.sockets).toHaveLength(1), { timeout: 1_000, interval: 5 })
    const socket = factory.sockets[0]!
    // La URL lleva el listenKey después de la ruta, sin barras dobles.
    expect(socket.url).toBe('wss://fstream.binance.com/private/ws/clave-de-escucha')
    socket.open()
    socket.emit('message', Buffer.from('no es json'), false)
    socket.receive({ e: 'STRATEGY_UPDATE', E: 1 })
    socket.receive([1, 2, 3])
    socket.receive({ e: 'ORDER_TRADE_UPDATE', E: 1, T: 1, o: { s: 'BTCUSDT', c: 'adl_autoclose', S: 'BUY', o: 'MARKET', q: '1', ap: '10', x: 'TRADE', X: 'FILLED', i: 7, l: '1', z: '1', L: '10', N: 'USDT', n: '0.01', T: 1, rp: '-2', R: true, ot: 'MARKET' } })
    expect(orders).toHaveLength(1)
    // ADL también cuenta como liquidación.
    expect(orders[0]).toMatchObject({ clientOrderId: 'adl_autoclose', liquidation: true, realizedPnl: -2, commission: 0.01 })
    await s.stop()
  })

  it('un evento conocido que llega mal formado pide resync; lo ilegible y lo desconocido no', async () => {
    const factory = fakeSocketFactory()
    const s = new UserDataStream({ trade, url: 'wss://fstream.binance.com/private/ws', WebSocket: factory.WebSocket, clock: realClock })
    let resyncs = 0
    s.on('resync', () => resyncs++)
    s.start()
    await vi.waitFor(() => expect(factory.sockets).toHaveLength(1), { timeout: 1_000, interval: 5 })
    const socket = factory.sockets[0]!
    socket.open()
    socket.emit('message', Buffer.from('no es json'), false)
    socket.receive({ e: 'STRATEGY_UPDATE', E: 1 })
    expect(resyncs).toBe(0)
    // Un fill perdido así no tiene que esperar a la reconciliación periódica.
    socket.receive({ e: 'ORDER_TRADE_UPDATE', E: 1, T: 1 })
    socket.receive({ e: 'ALGO_UPDATE', E: 1, T: 1, o: { s: 'BTCUSDT', caid: 'sereno-0a1b2c3d-s1', aid: 'no-es-un-número', o: 'STOP_MARKET', S: 'SELL', q: '1', X: 'NEW', tp: '95' } })
    expect(resyncs).toBe(2)
    expect(s.connected).toBe(true)
    await s.stop()
  })

  it('si para mientras pide el listenKey, cierra el que llega y no conecta', async () => {
    const factory = fakeSocketFactory()
    let release!: (key: string) => void
    let closes = 0
    const slow = {
      listenKeyCreate: (): Promise<string> =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
      listenKeyKeepAlive: async (): Promise<void> => {},
      listenKeyClose: async (): Promise<void> => {
        closes++
      },
    }
    const s = new UserDataStream({ trade: slow, url: 'wss://fstream.binance.com/private/ws', WebSocket: factory.WebSocket, clock: realClock })
    s.start()
    await s.stop()
    expect(closes).toBe(0)
    release('clave-tardía')
    await vi.waitFor(() => expect(closes).toBe(1), { timeout: 1_000, interval: 5 })
    expect(factory.sockets).toHaveLength(0)
  })

  it('un listenKeyExpired de otro listenKey no reconecta', async () => {
    const factory = fakeSocketFactory()
    const s = new UserDataStream({ trade, url: 'wss://fstream.binance.com/private/ws', WebSocket: factory.WebSocket, clock: realClock })
    s.start()
    await vi.waitFor(() => expect(factory.sockets).toHaveLength(1), { timeout: 1_000, interval: 5 })
    factory.sockets[0]!.open()
    factory.sockets[0]!.receive({ e: 'listenKeyExpired', E: '1736996475556', listenKey: 'otra-clave' })
    await new Promise((r) => setTimeout(r, 20))
    expect(factory.sockets).toHaveLength(1)
    expect(s.connected).toBe(true)
    await s.stop()
  })
})
