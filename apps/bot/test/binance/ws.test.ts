import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { Candle, MarkTick, Timeframe } from '@sereno/core'
import { MarketStream, buildStreamUrl, quietReconnectTime, type MarketStreamOptions, type StreamStatus } from '../../src/binance/ws'
import { FakeBinance } from '../../src/binance/fake/server'
import { klineEvent, markPriceEvent } from '../../src/binance/fake/fixtures'

const MIN15 = 15 * 60_000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)

async function waitFor(check: () => boolean, { timeout = 2_000, step = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: se venció el plazo')
    await new Promise((r) => setTimeout(r, step))
  }
}

describe('buildStreamUrl', () => {
  it('arma la URL /market/stream con los streams en minúscula', () => {
    const url = buildStreamUrl('wss://fstream.binance.com/market/stream', ['BTCUSDT', 'ETHUSDT'], ['kline_15m', 'markPrice@1s'])
    expect(url).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_15m/btcusdt@markPrice@1s/ethusdt@kline_15m/ethusdt@markPrice@1s')
    expect(url).toContain('/market/')
  })

  it('rechaza las rutas legadas /ws y /stream sin ruta', () => {
    expect(() => buildStreamUrl('wss://fstream.binance.com/ws', ['BTCUSDT'], ['kline_15m'])).toThrow(/\/market\//)
    expect(() => buildStreamUrl('wss://fstream.binance.com/stream', ['BTCUSDT'], ['kline_15m'])).toThrow(/\/market\//)
    expect(() => new MarketStream({ url: 'wss://fstream.binance.com/stream', symbols: ['BTCUSDT'] })).toThrow(/\/market\//)
  })

  it('no acepta más de 1024 streams por conexión ni una conexión sin streams', () => {
    const symbols = Array.from({ length: 257 }, (_, i) => `S${i}USDT`)
    expect(() => buildStreamUrl('wss://fstream.binance.com/market/stream', symbols, ['kline_15m', 'kline_1h', 'kline_4h', 'markPrice@1s'])).toThrow(/1024/)
    expect(() => new MarketStream({ url: 'wss://fstream.binance.com/market/stream', symbols: [] })).toThrow(/al menos un símbolo/)
  })
})

describe('quietReconnectTime', () => {
  it('corre la reconexión fuera de los 10 s que siguen al cierre de una vela de 15m', () => {
    const boundary = T0 + MIN15
    expect(quietReconnectTime(boundary)).toBe(boundary + 10_000)
    expect(quietReconnectTime(boundary + 9_999)).toBe(boundary + 10_000)
    expect(quietReconnectTime(boundary + 10_000)).toBe(boundary + 10_000)
    expect(quietReconnectTime(boundary + 5 * 60_000)).toBe(boundary + 5 * 60_000)
  })
  it('tampoco cae en los 10 s previos al cierre', () => {
    const boundary = T0 + MIN15
    expect(quietReconnectTime(boundary - 1)).toBe(boundary + 10_000)
    expect(quietReconnectTime(boundary - 10_000)).toBe(boundary + 10_000)
    expect(quietReconnectTime(boundary - 10_001)).toBe(boundary - 10_001)
  })
})

describe('MarketStream contra el servidor falso', () => {
  let fake: FakeBinance
  let stream: MarketStream | null = null

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
  })
  afterEach(() => {
    stream?.stop()
    stream = null
  })

  function open(overrides: Partial<MarketStreamOptions> = {}): MarketStream {
    stream = new MarketStream({
      url: fake.wsUrl,
      symbols: ['BTCUSDT', 'ETHUSDT'],
      backoffBaseMs: 10,
      backoffMaxMs: 20,
      pingIntervalMs: 60_000,
      staleAfterMs: 60_000,
      ...overrides,
    })
    return stream
  }

  it('se conecta a /market/stream con los 4 streams por símbolo y avisa connected', async () => {
    const statuses: StreamStatus[] = []
    const s = open()
    s.on('status', (st) => statuses.push(st))
    expect(s.url).toContain('/market/')
    s.start()
    await waitFor(() => statuses.includes('connected'))
    const [conn] = fake.wsConnections
    expect(conn!.path).toBe('/market/stream')
    expect(conn!.streams).toEqual([
      'btcusdt@kline_15m',
      'btcusdt@kline_1h',
      'btcusdt@kline_4h',
      'btcusdt@markPrice@1s',
      'ethusdt@kline_15m',
      'ethusdt@kline_1h',
      'ethusdt@kline_4h',
      'ethusdt@markPrice@1s',
    ])
  })

  it('emite kline sólo cuando x = true, con la vela convertida', async () => {
    const klines: Array<{ symbol: string; tf: Timeframe; candle: Candle }> = []
    const s = open()
    s.on('kline', (symbol, tf, candle) => klines.push({ symbol, tf, candle }))
    s.start()
    await fake.waitForWsConnections(1)

    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, close: 68_100, closed: false }))
    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, close: 68_200, closed: true }))
    await waitFor(() => klines.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(klines).toHaveLength(1)
    expect(klines[0]).toEqual({
      symbol: 'BTCUSDT',
      tf: '15m',
      candle: { openTime: T0, closeTime: T0 + MIN15 - 1, open: 68_000, high: 68_250, low: 67_900, close: 68_200, volume: 120.5, quoteVolume: 8_200_000, closed: true },
    })
  })

  it('emite mark con fundingRate de r, nextFundingTime de T y el último precio operado del kline', async () => {
    const ticks: MarkTick[] = []
    const s = open()
    s.on('mark', (t) => ticks.push(t))
    s.start()
    await fake.waitForWsConnections(1)

    const nextFunding = T0 + 4 * 3_600_000
    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, close: 68_123.4, closed: false }))
    fake.push('btcusdt@markPrice@1s', markPriceEvent({ symbol: 'BTCUSDT', markPrice: 68_010.5, fundingRate: '0.00012500', nextFundingTime: nextFunding, at: T0 + 1_000 }))
    fake.push('ethusdt@markPrice@1s', markPriceEvent({ symbol: 'ETHUSDT', markPrice: 2_500, fundingRate: '', nextFundingTime: 0, at: T0 + 1_000 }))
    await waitFor(() => ticks.length === 2)
    expect(ticks[0]).toEqual({ symbol: 'BTCUSDT', markPrice: 68_010.5, lastPrice: 68_123.4, at: T0 + 1_000, fundingRate: 0.000125, nextFundingTime: nextFunding })
    // Sin kline previo el último precio cae al de marca; funding vacío ⇒ null.
    expect(ticks[1]).toEqual({ symbol: 'ETHUSDT', markPrice: 2_500, lastPrice: 2_500, at: T0 + 1_000, fundingRate: null, nextFundingTime: null })
  })

  it('emite gap cuando llega una vela con openTime dos períodos adelante, antes de la vela', async () => {
    const events: string[] = []
    const gaps: Array<{ symbol: string; tf: Timeframe; from: number; to: number }> = []
    const s = open()
    s.on('kline', (symbol, tf, candle) => events.push(`kline:${symbol}:${tf}:${candle.openTime}`))
    s.on('gap', (g) => {
      gaps.push(g)
      events.push(`gap:${g.symbol}:${g.tf}:${g.from}`)
    })
    s.start()
    await fake.waitForWsConnections(1)

    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, closed: true }))
    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0 + MIN15, closed: true }))
    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0 + 3 * MIN15, closed: true }))
    await waitFor(() => events.length === 4)
    expect(gaps).toEqual([{ symbol: 'BTCUSDT', tf: '15m', from: T0 + 2 * MIN15, to: T0 + 2 * MIN15 }])
    expect(events).toEqual([`kline:BTCUSDT:15m:${T0}`, `kline:BTCUSDT:15m:${T0 + MIN15}`, `gap:BTCUSDT:15m:${T0 + 2 * MIN15}`, `kline:BTCUSDT:15m:${T0 + 3 * MIN15}`])
  })

  it('ignora una vela cerrada repetida o anterior a la última vista', async () => {
    const seen: number[] = []
    const s = open()
    s.on('kline', (_symbol, _tf, candle) => seen.push(candle.openTime))
    s.start()
    await fake.waitForWsConnections(1)
    fake.push('btcusdt@kline_1h', klineEvent({ symbol: 'BTCUSDT', interval: '1h', openTime: T0, closed: true }))
    fake.push('btcusdt@kline_1h', klineEvent({ symbol: 'BTCUSDT', interval: '1h', openTime: T0, closed: true }))
    fake.push('btcusdt@kline_1h', klineEvent({ symbol: 'BTCUSDT', interval: '1h', openTime: T0 - 3_600_000, closed: true }))
    fake.push('btcusdt@kline_1h', klineEvent({ symbol: 'BTCUSDT', interval: '1h', openTime: T0 + 3_600_000, closed: true }))
    await waitFor(() => seen.length === 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([T0, T0 + 3_600_000])
  })

  it('se reconecta con backoff cuando el servidor corta y recuerda la última vela para detectar el hueco', async () => {
    const statuses: StreamStatus[] = []
    const gaps: Array<{ from: number; to: number }> = []
    const s = open()
    s.on('status', (st) => statuses.push(st))
    s.on('gap', (g) => gaps.push({ from: g.from, to: g.to }))
    s.start()
    await fake.waitForWsConnections(1)
    fake.push('ethusdt@kline_15m', klineEvent({ symbol: 'ETHUSDT', interval: '15m', openTime: T0, closed: true }))
    await new Promise((r) => setTimeout(r, 20))

    fake.dropClients()
    await fake.waitForWsConnections(2)
    await waitFor(() => statuses.filter((st) => st === 'connected').length === 2)
    expect(statuses).toEqual(['connected', 'reconnecting', 'connected'])

    fake.push('ethusdt@kline_15m', klineEvent({ symbol: 'ETHUSDT', interval: '15m', openTime: T0 + 4 * MIN15, closed: true }))
    await waitFor(() => gaps.length === 1)
    expect(gaps[0]).toEqual({ from: T0 + MIN15, to: T0 + 3 * MIN15 })
  })

  it('manda un pong proactivo cada pingIntervalMs', async () => {
    const s = open({ pingIntervalMs: 30 })
    s.start()
    await fake.waitForWsConnections(1)
    await waitFor(() => fake.pongs >= 2)
  })

  // Que la causa sea el vigía (el cliente corta) se prueba con el socket falso en ws-connection.test.ts.
  it('reconecta si no llega ningún mensaje en staleAfterMs', async () => {
    const statuses: StreamStatus[] = []
    const s = open({ staleAfterMs: 50 })
    s.on('status', (st) => statuses.push(st))
    s.start()
    await fake.waitForWsConnections(2)
    expect(statuses).toContain('reconnecting')
  })

  it('scheduleReconnectAt reconecta a la hora pedida (corrida a un momento tranquilo)', async () => {
    // Reloj corrido a mitad de una vela de 15m: si el test corriera justo después de un
    // cierre, la hora pedida se correría 10 s (comportamiento correcto) y el test vencería.
    const shift = 5 * 60_000 - (Date.now() % MIN15)
    const now = (): number => Date.now() + shift
    const s = open({ now })
    s.start()
    await fake.waitForWsConnections(1)
    s.scheduleReconnectAt(now() + 30)
    await fake.waitForWsConnections(2)
    expect(fake.wsConnections[1]!.streams).toEqual(fake.wsConnections[0]!.streams)
  })

  it('programa por defecto la reconexión a las 23 h en un momento tranquilo', () => {
    const s = open()
    const t = Date.now()
    s.start()
    const plan = s.plannedReconnectAt
    expect(plan).not.toBeNull()
    expect(plan!).toBeGreaterThanOrEqual(t + 23 * 3_600_000)
    expect(plan!).toBeLessThan(t + 23 * 3_600_000 + 25_000)
    expect(plan! % MIN15).toBeGreaterThanOrEqual(10_000)
    expect(plan! % MIN15).toBeLessThanOrEqual(MIN15 - 10_001)
  })

  // El ritmo exacto (uno cada 200 ms) se prueba con reloj falso en ws-subscriptions.test.ts.
  it('subscribe manda SUBSCRIBE de a uno y persiste en la reconexión', async () => {
    const s = open()
    s.start()
    await waitFor(() => s.status === 'connected')
    s.subscribe(['SOLUSDT'])
    s.subscribe(['xrpusdt'])
    await waitFor(() => fake.wsMessages.length === 2)
    const [m1, m2] = fake.wsMessages
    expect(m1!.message).toMatchObject({ method: 'SUBSCRIBE', params: ['solusdt@kline_15m', 'solusdt@kline_1h', 'solusdt@kline_4h', 'solusdt@markPrice@1s'] })
    expect(m2!.message).toMatchObject({ method: 'SUBSCRIBE', params: ['xrpusdt@kline_15m', 'xrpusdt@kline_1h', 'xrpusdt@kline_4h', 'xrpusdt@markPrice@1s'] })
    expect(s.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])

    expect(() => s.unsubscribe(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])).toThrow(/último símbolo/)
    s.unsubscribe(['ETHUSDT'])
    await waitFor(() => fake.wsMessages.length === 3)
    expect(fake.wsMessages[2]!.message).toMatchObject({ method: 'UNSUBSCRIBE', params: ['ethusdt@kline_15m', 'ethusdt@kline_1h', 'ethusdt@kline_4h', 'ethusdt@markPrice@1s'] })

    fake.dropClients()
    await fake.waitForWsConnections(2)
    expect(fake.wsConnections[1]!.streams).toEqual([
      'btcusdt@kline_15m',
      'btcusdt@kline_1h',
      'btcusdt@kline_4h',
      'btcusdt@markPrice@1s',
      'solusdt@kline_15m',
      'solusdt@kline_1h',
      'solusdt@kline_4h',
      'solusdt@markPrice@1s',
      'xrpusdt@kline_15m',
      'xrpusdt@kline_1h',
      'xrpusdt@kline_4h',
      'xrpusdt@markPrice@1s',
    ])
  })

  it('subscribe y unsubscribe pedidos mientras conecta llegan al servidor', async () => {
    const seen: string[] = []
    const s = open()
    s.on('kline', (symbol) => seen.push(symbol))
    s.start()
    s.subscribe(['SOLUSDT'])
    s.unsubscribe(['ETHUSDT'])
    await fake.waitForWsConnections(1)
    const [conn] = fake.wsConnections
    await waitFor(() => fake.wsMessages.length === 2)
    expect(fake.wsMessages.map((m) => (m.message as { method: string }).method)).toEqual(['UNSUBSCRIBE', 'SUBSCRIBE'])
    expect(conn!.streams).toEqual(['btcusdt@kline_15m', 'btcusdt@kline_1h', 'btcusdt@kline_4h', 'btcusdt@markPrice@1s', 'solusdt@kline_15m', 'solusdt@kline_1h', 'solusdt@kline_4h', 'solusdt@markPrice@1s'])

    fake.push('solusdt@kline_15m', klineEvent({ symbol: 'SOLUSDT', interval: '15m', openTime: T0, closed: true }))
    fake.push('ethusdt@kline_15m', klineEvent({ symbol: 'ETHUSDT', interval: '15m', openTime: T0, closed: true }))
    fake.push('btcusdt@kline_15m', klineEvent({ symbol: 'BTCUSDT', interval: '15m', openTime: T0, closed: true }))
    await waitFor(() => seen.length === 2)
    expect(seen).toEqual(['SOLUSDT', 'BTCUSDT'])
  })

  it('stop cierra sin reconectar y avisa closed', async () => {
    const statuses: StreamStatus[] = []
    const s = open()
    s.on('status', (st) => statuses.push(st))
    s.start()
    await fake.waitForWsConnections(1)
    s.stop()
    await waitFor(() => statuses.includes('closed'))
    await waitFor(() => fake.wsConnections[0]!.socket.readyState === 3 /* CLOSED */)
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.wsConnections).toHaveLength(1)
    expect(statuses).toEqual(['connected', 'closed'])
  })

  it('on devuelve una función para darse de baja', async () => {
    const ticks: MarkTick[] = []
    const s = open()
    const off = s.on('mark', (t) => ticks.push(t))
    s.start()
    await fake.waitForWsConnections(1)
    fake.push('btcusdt@markPrice@1s', markPriceEvent({ symbol: 'BTCUSDT', markPrice: 1, fundingRate: '0', nextFundingTime: T0, at: T0 }))
    await waitFor(() => ticks.length === 1)
    off()
    fake.push('btcusdt@markPrice@1s', markPriceEvent({ symbol: 'BTCUSDT', markPrice: 2, fundingRate: '0', nextFundingTime: T0, at: T0 }))
    await new Promise((r) => setTimeout(r, 30))
    expect(ticks).toHaveLength(1)
  })
})
