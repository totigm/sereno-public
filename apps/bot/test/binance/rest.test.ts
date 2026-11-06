import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { BinanceRest } from '../../src/binance/rest'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../../src/binance/errors'
import { FakeBinance } from '../../src/binance/fake/server'
import { EXCHANGE_INFO, GEO_BLOCK_MESSAGE } from '../../src/binance/fake/fixtures'
import { createLogger } from '../../src/logger'
import { logSink } from '../helpers/log-sink'

const LIMITS = { weightPerMinute: 2400, dataRequestsPer5m: 1000, fundingRequestsPer5m: 500 }
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0) // 2026-10-01T00:00:00Z (en el pasado: el falso sirve velas hasta "ahora")
const MIN15 = 15 * 60_000

describe('BinanceRest', () => {
  let fake: FakeBinance
  let limiter: RateLimiter
  let rest: BinanceRest
  let sleeps: number[]
  // Reloj virtual compartido: `sleep` no espera de verdad, adelanta el reloj (así el
  // castigo que el 429 le impone al limitador también vence).
  let offset = 0
  const now = (): number => Date.now() + offset

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(() => {
    fake.reset()
    sleeps = []
    offset = 0
    limiter = new RateLimiter({ ...LIMITS, now })
    rest = new BinanceRest({
      baseUrl: fake.baseUrl,
      limiter,
      maxRetries: 3,
      now,
      sleep: async (ms) => {
        sleeps.push(ms)
        offset += ms
      },
    })
  })

  describe('klines', () => {
    it('convierte el array de Binance a Candle con closed = true y closeTime = openTime + ms − 1', async () => {
      const candles = await rest.klines('BTCUSDT', '15m', { startTime: T0, limit: 3 })
      expect(candles).toHaveLength(3)
      const [first] = candles
      expect(first).toBeDefined()
      expect(first!.openTime).toBe(T0)
      expect(first!.closeTime).toBe(T0 + MIN15 - 1)
      expect(first!.closed).toBe(true)
      for (const key of ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'] as const) {
        expect(typeof first![key]).toBe('number')
        expect(Number.isFinite(first![key])).toBe(true)
      }
      expect(first!.high).toBeGreaterThanOrEqual(Math.max(first!.open, first!.close))
      expect(first!.low).toBeLessThanOrEqual(Math.min(first!.open, first!.close))
      expect(candles.map((c) => c.openTime)).toEqual([T0, T0 + MIN15, T0 + 2 * MIN15])

      const [req] = fake.requests
      expect(req).toMatchObject({ path: '/fapi/v1/klines', query: { symbol: 'BTCUSDT', interval: '15m', startTime: String(T0), limit: '3' } })
    })

    it('pesa 1 con limit < 100 y 10 con limit 1500', async () => {
      const acquire = vi.spyOn(limiter, 'acquire')
      await rest.klines('BTCUSDT', '15m', { limit: 50 })
      expect(acquire).toHaveBeenLastCalledWith('weight', 1)
      await rest.klines('BTCUSDT', '15m', { limit: 1500 })
      expect(acquire).toHaveBeenLastCalledWith('weight', 10)
      await rest.klines('BTCUSDT', '1h')
      expect(acquire).toHaveBeenLastCalledWith('weight', 10) // el default es 1500
    })

    it('markPriceKlines y dailyKlines usan sus endpoints', async () => {
      const mark = await rest.markPriceKlines('ETHUSDT', '1h', { startTime: T0, limit: 2 })
      expect(mark).toHaveLength(2)
      expect(mark[0]!.closeTime).toBe(T0 + 60 * 60_000 - 1)
      expect(mark[0]!.volume).toBe(0)
      const daily = await rest.dailyKlines('ETHUSDT', T0, T0 + 2 * 86_400_000)
      expect(daily.map((c) => c.openTime)).toEqual([T0, T0 + 86_400_000, T0 + 2 * 86_400_000])
      expect(fake.requests.map((r) => r.path)).toEqual(['/fapi/v1/markPriceKlines', '/fapi/v1/klines'])
      expect(fake.requests[1]!.query).toMatchObject({ interval: '1d', startTime: String(T0), endTime: String(T0 + 2 * 86_400_000) })
    })

    it('rechaza un limit fuera de 1..1500 antes de pedir', async () => {
      await expect(rest.klines('BTCUSDT', '15m', { limit: 2000 })).rejects.toThrow(RangeError)
      await expect(rest.klines('BTCUSDT', '15m', { limit: 0 })).rejects.toThrow(/1\.\.1500/)
      expect(fake.requests).toHaveLength(0)
    })

    it('marca closed = false la vela cuyo cierre todavía no llegó', async () => {
      const now = T0 + MIN15 + 5_000
      const local = new BinanceRest({ baseUrl: fake.baseUrl, limiter, now: () => now, sleep: async () => {} })
      fake.now = () => now
      const candles = await local.klines('BTCUSDT', '15m', { startTime: T0, limit: 5 })
      expect(candles.map((c) => c.closed)).toEqual([true, false])
    })
  })

  describe('errores', () => {
    it('451 ⇒ BinanceGeoBlocked sin reintentar', async () => {
      fake.failNext('/fapi/v1/klines', { status: 451, body: { code: 0, msg: GEO_BLOCK_MESSAGE } })
      const err = await rest.klines('BTCUSDT', '15m', { limit: 1 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceGeoBlocked)
      expect((err as BinanceGeoBlocked).status).toBe(451)
      expect((err as BinanceGeoBlocked).message).toContain('restricted location')
      expect(fake.requests).toHaveLength(1)
      expect(sleeps).toEqual([])
    })

    it('429 ⇒ reintento con backoff que respeta Retry-After', async () => {
      fake.failNext('/fapi/v1/klines', { status: 429, headers: { 'Retry-After': '2' }, body: { code: -1003, msg: 'Too many requests' } })
      const candles = await rest.klines('BTCUSDT', '15m', { limit: 1 })
      expect(candles).toHaveLength(1)
      expect(fake.requests).toHaveLength(2)
      expect(sleeps).toEqual([2_000])
    })

    it('429 frena también al limitador mientras dura el castigo', async () => {
      const hold = vi.spyOn(limiter, 'holdUntil')
      fake.failNext('/fapi/v1/klines', { status: 429, headers: { 'Retry-After': '3' } })
      await rest.klines('BTCUSDT', '15m', { limit: 1 })
      expect(hold).toHaveBeenCalledTimes(1)
      expect(hold.mock.calls[0]![0]).toBeGreaterThanOrEqual(Date.now() + 2_900)
    })

    it('418 ⇒ backoff exponencial y agota los reintentos con BinanceRateLimited', async () => {
      fake.failNext('/fapi/v1/premiumIndex', { status: 418, body: { code: -1003, msg: 'IP banned' } }, 10)
      const err = await rest.premiumIndex().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceRateLimited)
      expect((err as BinanceRateLimited).status).toBe(418)
      expect(fake.requests).toHaveLength(4) // intento + 3 reintentos
      expect(sleeps).toEqual([1_000, 2_000, 4_000])
    })

    it('5xx y errores de red se reintentan; 4xx se tipan con código y mensaje', async () => {
      fake.failNext('/fapi/v1/ping', { status: 503, body: { code: -1001, msg: 'Internal error' } })
      await rest.ping()
      expect(fake.requests).toHaveLength(2)
      expect(sleeps).toEqual([1_000])

      fake.failNext('/fapi/v1/ping', { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } })
      const err = await rest.ping().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceHttpError)
      expect(err).toMatchObject({ status: 400, code: -1121, message: expect.stringContaining('Invalid symbol.') })
      expect(fake.requests).toHaveLength(3)
    })
  })

  describe('fallos de red', () => {
    type Step = 'throw' | 'unreadable' | 'stall' | 'real'
    // Cliente con un `fetch` guionado: cada llamada usa el siguiente paso (el último se
    // repite); `'real'` delega en el servidor falso.
    function scriptedRest(script: Step[], extra: { requestTimeoutMs?: number } = {}): { rest: BinanceRest; signals: Array<AbortSignal | null | undefined> } {
      const signals: Array<AbortSignal | null | undefined> = []
      let call = 0
      const fetchImpl: typeof fetch = (input, init) => {
        signals.push(init?.signal)
        const step = script[Math.min(call++, script.length - 1)]
        if (step === 'throw') return Promise.reject(new TypeError('fetch failed'))
        if (step === 'unreadable') return Promise.resolve(new Response('<html>proxy</html>', { status: 200 }))
        if (step === 'stall') {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })
        }
        return fetch(input, init)
      }
      const local = new BinanceRest({
        baseUrl: fake.baseUrl,
        limiter,
        maxRetries: 3,
        now,
        fetch: fetchImpl,
        ...extra,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      })
      return { rest: local, signals }
    }

    it('un fetch que lanza se reintenta con backoff', async () => {
      const { rest: local } = scriptedRest(['throw', 'real'])
      await local.ping()
      expect(sleeps).toEqual([1_000])
      expect(fake.requests).toHaveLength(1)
    })

    it('agotados los reintentos de red lanza BinanceNetworkError con la causa', async () => {
      const { rest: local } = scriptedRest(['throw'])
      const err = await local.ping().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceNetworkError)
      expect((err as BinanceNetworkError).path).toBe('/fapi/v1/ping')
      expect((err as BinanceNetworkError).cause).toBeInstanceOf(TypeError)
      expect(sleeps).toEqual([1_000, 2_000, 4_000])
    })

    it('un 200 con cuerpo ilegible se reintenta y, si persiste, es BinanceNetworkError', async () => {
      const once = scriptedRest(['unreadable', 'real'])
      await once.rest.ping()
      expect(sleeps).toEqual([1_000])

      const always = scriptedRest(['unreadable'])
      const err = await always.rest.ping().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BinanceNetworkError)
      expect((err as Error).message).toMatch(/ilegible/)
    })

    it('corta el pedido que no responde en requestTimeoutMs y lo reintenta', async () => {
      const { rest: local, signals } = scriptedRest(['stall', 'real'], { requestTimeoutMs: 20 })
      await local.ping()
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      expect(signals[0]!.aborted).toBe(true)
      expect(sleeps).toEqual([1_000])
    })

    it('si nunca responde, BinanceNetworkError dice que venció el plazo', async () => {
      const { rest: local } = scriptedRest(['stall'], { requestTimeoutMs: 10 })
      await expect(local.ping()).rejects.toThrow(/10 ms/)
    })
  })

  describe('limitador', () => {
    it('informa el header X-MBX-USED-WEIGHT-1M al limitador', async () => {
      fake.setUsedWeight(2395)
      const observe = vi.spyOn(limiter, 'observeHeader')
      await rest.ping()
      expect(observe).toHaveBeenCalledWith(2395)
    })

    it('usa la clase de límite correcta por endpoint', async () => {
      const acquire = vi.spyOn(limiter, 'acquire')
      await rest.ticker24h()
      expect(acquire).toHaveBeenLastCalledWith('weight', 40)
      await rest.premiumIndex()
      expect(acquire).toHaveBeenLastCalledWith('weight', 10)
      await rest.premiumIndex('BTCUSDT')
      expect(acquire).toHaveBeenLastCalledWith('weight', 1)
      await rest.exchangeInfo()
      expect(acquire).toHaveBeenLastCalledWith('weight', 1)
      await rest.bookTicker('BTCUSDT')
      expect(acquire).toHaveBeenLastCalledWith('weight', 2)
      await rest.fundingRate('BTCUSDT', { limit: 3 })
      expect(acquire).toHaveBeenLastCalledWith('funding', 0)
      await rest.fundingInfo()
      expect(acquire).toHaveBeenLastCalledWith('funding', 0)
      await rest.openInterestHist('BTCUSDT', '1h', 5)
      expect(acquire).toHaveBeenLastCalledWith('data', 0)
      await rest.globalLongShortAccountRatio('BTCUSDT', '1h', 5)
      expect(acquire).toHaveBeenLastCalledWith('data', 0)
      await rest.takerLongShortRatio('BTCUSDT', '1h', 5)
      expect(acquire).toHaveBeenLastCalledWith('data', 0)
      expect(fake.requests.map((r) => r.path)).toEqual([
        '/fapi/v1/ticker/24hr',
        '/fapi/v1/premiumIndex',
        '/fapi/v1/premiumIndex',
        '/fapi/v1/exchangeInfo',
        '/fapi/v1/ticker/bookTicker',
        '/fapi/v1/fundingRate',
        '/fapi/v1/fundingInfo',
        '/futures/data/openInterestHist',
        '/futures/data/globalLongShortAccountRatio',
        '/futures/data/takerlongshortRatio',
      ])
    })
  })

  describe('parseo de respuestas', () => {
    it('exchangeInfo devuelve ContractMeta con los filtros numéricos', async () => {
      const contracts = await rest.exchangeInfo()
      const btc = contracts.find((c) => c.symbol === 'BTCUSDT')
      expect(btc).toEqual({
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        contractType: 'PERPETUAL',
        status: 'TRADING',
        underlyingType: 'COIN',
        underlyingSubType: ['PoW'],
        onboardDate: 1569398400000,
        filters: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, quantityPrecision: 3, liquidationFee: 0.0125 },
      })
      expect(contracts.map((c) => c.symbol)).toContain('XAUUSDT')
    })

    it('exchangeInfo omite, con un aviso, el contrato con datos inválidos', async () => {
      const out = logSink()
      const local = new BinanceRest({ baseUrl: fake.baseUrl, limiter, now, logger: createLogger({ level: 'warn', destination: out.stream }) })
      const [btc, eth] = EXCHANGE_INFO.symbols
      const { filters: _filters, ...withoutFilters } = eth!
      fake.failNext('/fapi/v1/exchangeInfo', {
        status: 200,
        body: { symbols: [btc, { ...eth, symbol: 'BADFEEUSDT', liquidationFee: 'n/a' }, { ...withoutFilters, symbol: 'NOFILTERSUSDT' }, eth] },
      })
      const contracts = await local.exchangeInfo()
      expect(contracts.map((c) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
      expect(out.lines().map((l) => l.symbol)).toEqual(['BADFEEUSDT', 'NOFILTERSUSDT'])
      expect(out.lines()[0]).toMatchObject({ level: 40, err: expect.stringContaining('n/a') })
    })

    it('ticker24h devuelve volumen en quote y cambio porcentual como números', async () => {
      const tickers = await rest.ticker24h()
      const btc = tickers.find((t) => t.symbol === 'BTCUSDT')
      expect(btc).toEqual({ symbol: 'BTCUSDT', lastPrice: 68_000, quoteVolume: 12_000_000_000, priceChangePercent: 1.25 })
    })

    it('premiumIndex con y sin símbolo', async () => {
      const one = await rest.premiumIndex('BTCUSDT')
      expect(one).toMatchObject({ symbol: 'BTCUSDT', markPrice: 68_010.5, indexPrice: 68_005, lastFundingRate: 0.0001, nextFundingTime: expect.any(Number), time: expect.any(Number) })
      const all = await rest.premiumIndex()
      expect(all.map((p) => p.symbol)).toContain('ETHUSDT')
    })

    it('bookTicker devuelve bid/ask numéricos', async () => {
      const book = await rest.bookTicker('BTCUSDT')
      expect(book).toEqual({ symbol: 'BTCUSDT', bidPrice: 68_000, bidQty: 1.5, askPrice: 68_000.1, askQty: 2, time: expect.any(Number) })
    })

    it('fundingRate devuelve FundingEvent ordenados y fundingInfo el intervalo por contrato', async () => {
      // `endTime` es inclusivo sobre `fundingTime`: 00:00, 08:00 y 16:00.
      const events = await rest.fundingRate('BTCUSDT', { startTime: T0, endTime: T0 + 86_400_000 - 1 })
      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ symbol: 'BTCUSDT', at: T0, rate: expect.any(Number), markPrice: expect.any(Number) })
      expect(events[1]!.at - events[0]!.at).toBe(8 * 3_600_000)
      expect(fake.requests[0]!.query).toMatchObject({ symbol: 'BTCUSDT', startTime: String(T0), endTime: String(T0 + 86_400_000 - 1) })

      const info = await rest.fundingInfo()
      expect(info.find((i) => i.symbol === 'SOLUSDT')).toMatchObject({ symbol: 'SOLUSDT', fundingIntervalHours: 4 })
    })

    it('openInterestHist y ratios devuelven series numéricas con timestamp', async () => {
      const oi = await rest.openInterestHist('BTCUSDT', '1h', 5)
      expect(oi).toHaveLength(5)
      expect(oi[0]).toEqual({ symbol: 'BTCUSDT', sumOpenInterest: expect.any(Number), sumOpenInterestValue: expect.any(Number), timestamp: expect.any(Number) })
      expect(oi[4]!.timestamp - oi[3]!.timestamp).toBe(3_600_000)
      const ls = await rest.globalLongShortAccountRatio('BTCUSDT', '1h', 2)
      expect(ls[0]).toEqual({ symbol: 'BTCUSDT', longShortRatio: expect.any(Number), longAccount: expect.any(Number), shortAccount: expect.any(Number), timestamp: expect.any(Number) })
      const taker = await rest.takerLongShortRatio('BTCUSDT', '1h', 2)
      expect(taker[0]).toEqual({ buySellRatio: expect.any(Number), buyVol: expect.any(Number), sellVol: expect.any(Number), timestamp: expect.any(Number) })
      expect(fake.requests[0]!.query).toMatchObject({ symbol: 'BTCUSDT', period: '1h', limit: '5' })
    })

    it('las series de futuros aceptan un rango y Binance sólo guarda los últimos 30 días', async () => {
      const HOUR = 3_600_000
      const end = Math.floor(now() / HOUR) * HOUR
      const startTime = end - 10 * HOUR
      const oi = await rest.openInterestHist('BTCUSDT', '1h', 500, { startTime, endTime: end - 5 * HOUR })
      expect(oi.map((p) => p.timestamp)).toEqual([0, 1, 2, 3, 4, 5].map((h) => startTime + h * HOUR))
      expect(fake.requests[0]!.query).toMatchObject({ startTime: String(startTime), endTime: String(end - 5 * HOUR) })
      const old = await rest.globalLongShortAccountRatio('BTCUSDT', '1h', 500, { startTime: end - 40 * 24 * HOUR })
      expect(old[0]!.timestamp).toBeGreaterThanOrEqual(end - 30 * 24 * HOUR)
      const taker = await rest.takerLongShortRatio('BTCUSDT', '1h', 3, { endTime: end - HOUR })
      expect(taker.map((p) => p.timestamp)).toEqual([end - 3 * HOUR, end - 2 * HOUR, end - HOUR])
    })
  })
})
