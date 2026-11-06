import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BTC_15M_CANDLES_FOR_BASELINE } from '@sereno/core/src/market/btc-context'
import { DAY_MS } from '@sereno/core/src/replay/clock'
import { compactReplayData } from '@sereno/core/src/replay/compact'
import { BinanceHttpError } from '../../src/binance/errors'
import { FakeBinance } from '../../src/binance/fake/server'
import { PERPETUAL_SYMBOLS } from '../../src/binance/fake/fixtures'
import { INTERVAL_MS } from '../../src/binance/types'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../../src/jobs/budget'
import { silentLogger } from '../../src/logger'
import { FUTURES_LOOKBACK_MS } from '../../src/market/futures-snapshots'
import { downloadReplayData, type DownloadStep } from '../../src/replay/download'
import { replayFutures } from '../../src/replay/futures'
import { replayPeriod } from '../../src/replay/period'
import { restFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'
import { TWO_COINS } from '../helpers/live'

const NOW = Date.UTC(2026, 9, 31, 12, 7)
const HOUR = 3_600_000
const SYMBOLS = [...PERPETUAL_SYMBOLS]

let fake: FakeBinance
let t: TestDb

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
  await t.query('delete from candles where symbol = any($1)', [SYMBOLS])
  await t.query('delete from futures_data where symbol = any($1)', [SYMBOLS])
})

function deps() {
  return { rest: restFor(fake, NOW).rest, repos: t.repos, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW), logger: silentLogger }
}

const klineRequests = () => fake.requests.filter((r) => r.path.endsWith('Klines') || r.path.endsWith('klines'))

describe('downloadReplayData', () => {
  it('arma el universo de cada día, las seis series con calentamiento, el funding, los futuros y BTC', async () => {
    const period = replayPeriod(3, NOW)
    const steps: DownloadStep[] = []
    const { data, meta } = await downloadReplayData(deps(), { period, now: NOW, settings: TWO_COINS }, async (s) => {
      steps.push(s)
    })

    expect(data.symbolsByDay).toEqual({ '2026-10-28': ['BTCUSDT', 'ETHUSDT'], '2026-10-29': ['BTCUSDT', 'ETHUSDT'], '2026-10-30': ['BTCUSDT', 'ETHUSDT'] })
    expect(meta.symbols).toEqual(['BTCUSDT', 'ETHUSDT'])
    const eth = data.candles.ETHUSDT!
    for (const tf of ['15m', '1h', '4h'] as const) {
      for (const series of [eth[tf].last, eth[tf].mark]) {
        expect(series[0]?.openTime).toBe(period.from - 300 * INTERVAL_MS[tf])
        expect(series.at(-1)?.openTime).toBe(period.to - INTERVAL_MS[tf])
        expect(series.every((c) => c.closed)).toBe(true)
      }
    }
    expect(data.btc['15m']).toHaveLength(BTC_15M_CANDLES_FOR_BASELINE + 300 + 3 * 96)
    expect(data.btc['4h'].at(-1)?.openTime).toBe(period.to - INTERVAL_MS['4h'])
    expect(data.infos.ETHUSDT?.fundingIntervalHours).toBe(8)
    const funding = data.funding.ETHUSDT!
    expect(funding[0]?.at).toBe(period.from - FUTURES_LOOKBACK_MS)
    expect(funding.at(-1)?.at).toBe(period.to - 8 * HOUR)
    expect(data.futures.ETHUSDT?.some((s) => s.openInterest !== null && s.longShortRatio !== null && s.takerRatio !== null)).toBe(true)
    // Hay datos desde antes del período (el margen previo): dentro del período, desde el principio.
    expect(meta.futuresDataFrom).toBe(period.from)
    expect(steps.filter((s) => s.stage === 'symbols').map((s) => s.done)).toEqual([1, 2])
    expect(steps.at(-1)).toEqual({ stage: 'symbols', done: 2, total: 2 })
    expect(meta.candlesDownloaded).toBeGreaterThan(0)
  })

  it('la segunda vez reutiliza las velas guardadas: no pide ninguna a Binance', async () => {
    const period = replayPeriod(3, NOW)
    const first = await downloadReplayData(deps(), { period, now: NOW, settings: TWO_COINS }, async () => undefined)
    fake.reset()
    restFor(fake, NOW)
    const second = await downloadReplayData(deps(), { period, now: NOW, settings: TWO_COINS }, async () => undefined)

    expect(klineRequests()).toEqual([])
    expect(second.meta.candlesDownloaded).toBe(0)
    expect(second.meta.candlesReused).toBe(first.meta.candlesReused + first.meta.candlesDownloaded)
    expect(second.data.candles.ETHUSDT?.['15m'].last).toEqual(first.data.candles.ETHUSDT?.['15m'].last)
    expect(second.data.btc).toEqual(first.data.btc)
  })

  it('con `compact`: cada moneda queda como la compacta `compactReplayData`, sin pedir las marcas de 1h y 4h', async () => {
    const period = replayPeriod(3, NOW)
    const compact = await downloadReplayData(deps(), { period, now: NOW, settings: TWO_COINS }, async () => undefined, { compact: true })
    const markIntervals = new Set(fake.requests.filter((r) => r.path.endsWith('markPriceKlines')).map((r) => r.query.interval))
    expect([...markIntervals]).toEqual(['15m'])
    const full = await downloadReplayData(deps(), { period, now: NOW, settings: TWO_COINS }, async () => undefined)

    expect(compact.data).toEqual(compactReplayData(full.data))
    const eth = compact.data.candles.ETHUSDT!
    expect(eth['15m'].last.length).toBe(full.data.candles.ETHUSDT!['15m'].last.length)
    expect(eth['1h'].mark.length).toBe(0)
    expect(compact.meta.symbols).toEqual(full.meta.symbols)
  })

  it('una moneda que Binance rechaza (400) queda fuera del universo; el resto sigue', async () => {
    const base = deps()
    const rest = Object.assign(Object.create(base.rest) as typeof base.rest, {
      markPriceKlines: (...args: Parameters<typeof base.rest.markPriceKlines>) =>
        args[0] === 'ETHUSDT' ? Promise.reject(new BinanceHttpError('Invalid symbol.', { status: 400, code: -1121, path: '/fapi/v1/markPriceKlines' })) : base.rest.markPriceKlines(...args),
    })
    const { data, meta } = await downloadReplayData({ ...base, rest }, { period: replayPeriod(2, NOW), now: NOW, settings: TWO_COINS }, async () => undefined)

    expect(data.symbolsByDay).toEqual({ '2026-10-29': ['BTCUSDT'], '2026-10-30': ['BTCUSDT'] })
    expect(Object.keys(data.candles)).toEqual(['BTCUSDT'])
    expect(meta.symbols).toEqual(['BTCUSDT'])
    expect(meta.skipped).toEqual([{ symbol: 'ETHUSDT', error: 'Invalid symbol.' }])
  })
})

describe('replayFutures', () => {
  it('interés abierto y ratios sólo donde Binance los guarda (30 días); el funding de todo el período', async () => {
    const from = Math.floor((NOW - 32 * DAY_MS) / DAY_MS) * DAY_MS
    const to = from + 3 * DAY_MS
    const result = await replayFutures(deps(), 'ETHUSDT', { from, to, now: NOW, fundingIntervalHours: 8 })

    const oldest = Math.ceil((NOW - 30 * DAY_MS + HOUR) / HOUR) * HOUR
    expect(result.dataFrom).toBe(oldest)
    expect(result.futures.filter((s) => s.at < oldest).every((s) => s.openInterest === null && s.takerRatio === null)).toBe(true)
    expect(result.futures.some((s) => s.at >= oldest && s.openInterest !== null)).toBe(true)
    expect(result.funding[0]?.at).toBe(from - FUTURES_LOOKBACK_MS)
    expect(result.funding).toHaveLength((to - (from - FUTURES_LOOKBACK_MS)) / (8 * HOUR))
    // La tasa de cada snapshot es la liquidada (la del historial), no la estimada del vivo.
    const settled = result.futures.find((s) => s.at === from)
    expect(settled?.fundingRate).toBe(result.funding.find((e) => e.at === from)?.rate)
  })

  it('un período más viejo que 30 días no pide datos de futuros', async () => {
    const from = Math.floor((NOW - 40 * DAY_MS) / DAY_MS) * DAY_MS
    const result = await replayFutures(deps(), 'ETHUSDT', { from, to: from + DAY_MS, now: NOW, fundingIntervalHours: 8 })

    expect(fake.requests.filter((r) => r.path.startsWith('/futures/data/'))).toEqual([])
    expect(result.dataFrom).toBeNull()
    expect(result.funding.length).toBeGreaterThan(0)
  })
})
