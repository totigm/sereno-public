import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { longShortRows, openInterestRows, takerRows } from '../../src/binance/fake/fixtures'
import { BinanceRateLimited } from '../../src/binance/errors'
import type { BinanceRest } from '../../src/binance/rest'
import type { RateLimiter } from '../../src/binance/rate-limiter'
import { FUTURES_POLL_INTERVAL_MS, FUTURES_REQUESTS_PER_SYMBOL, pollFuturesData } from '../../src/jobs/futures-data'
import { loadFuturesSnapshots } from '../../src/market/futures-snapshots'
import { createLogger, silentLogger } from '../../src/logger'
import { restFor } from '../helpers/binance'
import { logSink } from '../helpers/log-sink'
import { openTestDb, type TestDb } from '../helpers/db'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 31, 10, 7, 0)
const LAST_HOUR = Math.floor(NOW / H) * H
const SYMBOLS = ['BTCUSDT', 'ETHUSDT']

let fake: FakeBinance
let t: TestDb
let rest: BinanceRest
let limiter: RateLimiter

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  fake.reset()
  ;({ rest, limiter } = restFor(fake, NOW))
  await t.query('delete from futures_data where symbol = any($1)', [SYMBOLS])
})

function deps() {
  return { rest, repos: t.repos, logger: silentLogger }
}

describe('pollFuturesData', () => {
  it('guarda OI y ratios de período 1h y el OI de hace 1 h y 4 h sale derivado de la serie', async () => {
    const result = await pollFuturesData(deps(), SYMBOLS)
    expect(result).toEqual({ points: 10, failed: [] })

    for (const symbol of SYMBOLS) {
      const oi = openInterestRows(symbol, 5, NOW)
      const ls = longShortRows(symbol, 5, NOW)
      const taker = takerRows(5, NOW)
      const stored = await t.repos.futures.range(symbol, LAST_HOUR - 4 * H, LAST_HOUR + 1)
      expect(stored.map((p) => p.at)).toEqual([4, 3, 2, 1, 0].map((h) => LAST_HOUR - h * H))
      expect(stored.at(-1)).toEqual({
        symbol,
        at: LAST_HOUR,
        fundingRate: null,
        nextFundingTime: null,
        openInterest: Number(oi.at(-1)!.sumOpenInterest),
        longShortRatio: Number(ls.at(-1)!.longShortRatio),
        takerRatio: Number(taker.at(-1)!.buySellRatio),
      })

      const snapshot = (await loadFuturesSnapshots(t.repos.futures, symbol, NOW, NOW + 1)).at(-1)
      // El OI de la última hora se ve desde el sondeo siguiente; el taker de esa hora todavía
      // no cerró su período, así que vale el de la anterior.
      expect(snapshot).toMatchObject({
        at: LAST_HOUR + FUTURES_POLL_INTERVAL_MS,
        openInterest: Number(oi[4]!.sumOpenInterest),
        openInterest1hAgo: Number(oi[3]!.sumOpenInterest),
        openInterest4hAgo: Number(oi[0]!.sumOpenInterest),
        takerRatio: Number(taker[3]!.buySellRatio),
      })
    }

    // Tres pedidos de /futures/data por símbolo, todos de período 1h.
    expect(FUTURES_REQUESTS_PER_SYMBOL).toBe(3)
    expect(fake.requests).toHaveLength(SYMBOLS.length * 3)
    expect(fake.requests.every((r) => r.path.startsWith('/futures/data/') && r.query.period === '1h' && r.query.limit === '5')).toBe(true)
    expect(limiter.used('data')).toBe(SYMBOLS.length * 3)
    expect(limiter.used('weight')).toBe(0)
  })

  it('no pisa el funding que escribió el stream en el mismo instante', async () => {
    await t.repos.futures.insert({ symbol: 'BTCUSDT', at: LAST_HOUR, fundingRate: 0.0001, nextFundingTime: LAST_HOUR + 8 * H, openInterest: null, longShortRatio: null, takerRatio: null })
    await pollFuturesData(deps(), ['BTCUSDT'])
    const point = await t.repos.futures.latest('BTCUSDT', NOW)
    expect(point).toMatchObject({ fundingRate: 0.0001, nextFundingTime: LAST_HOUR + 8 * H })
    expect(point?.openInterest).toBeGreaterThan(0)
  })

  it('un 4xx de un símbolo lo informa, guarda lo que sí llegó y sigue con los demás', async () => {
    fake.failNext('/futures/data/openInterestHist', { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } })
    const sink = logSink()
    const logger = createLogger({ level: 'warn', destination: sink.stream })
    const result = await pollFuturesData({ ...deps(), logger, concurrency: 1 }, SYMBOLS)

    expect(result).toEqual({ points: 10, failed: [{ symbol: 'BTCUSDT', error: expect.stringContaining('Invalid symbol.') }] })
    const btc = await t.repos.futures.range('BTCUSDT', 0, NOW)
    expect(btc).toHaveLength(5)
    expect(btc.every((p) => p.openInterest === null && p.longShortRatio !== null && p.takerRatio !== null)).toBe(true)
    expect((await t.repos.futures.range('ETHUSDT', 0, NOW)).every((p) => p.openInterest !== null)).toBe(true)
    expect(sink.lines()).toEqual([expect.objectContaining({ level: 40, symbol: 'BTCUSDT' })])
  })

  it('un 429 sin reintentos es de todos: se propaga', async () => {
    fake.failNext('/futures/data/openInterestHist', { status: 429, body: { code: -1003, msg: 'Too many requests' } })
    await expect(pollFuturesData({ ...deps(), concurrency: 1 }, SYMBOLS)).rejects.toBeInstanceOf(BinanceRateLimited)
  })
})
