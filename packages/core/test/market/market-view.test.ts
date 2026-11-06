import { describe, it, expect } from 'vitest'
import { buildBtcContext } from '../../src/market/btc-context'
import { CandleSeries } from '../../src/market/candle-series'
import { buildMarketView, DEFAULT_WARMUP, type MarketViewInput } from '../../src/market/market-view'
import type { BtcContext, Candle, FuturesSnapshot, Timeframe } from '../../src/types'
import { TF_MS, candle, candleRun, symbolInfo, utc } from './fixtures'

const seriesOf = (tf: Timeframe, candles: Candle[] = []): CandleSeries => {
  const s = new CandleSeries(tf)
  for (const c of candles) s.upsert(c)
  return s
}

const snapshot = (at: number): FuturesSnapshot => ({
  at,
  fundingRate: 0.0001,
  nextFundingTime: at + 8 * TF_MS['1h'],
  openInterest: 1_000,
  openInterest1hAgo: 990,
  openInterest4hAgo: 950,
  longShortRatio: 1.2,
  takerRatio: 1.05,
})

// Vista mínima fechada en `t`; cada test pisa sólo lo que le importa.
const inputAt = (t: number, overrides: Partial<MarketViewInput> = {}): MarketViewInput => ({
  t,
  symbol: 'ETHUSDT',
  info: symbolInfo('ETHUSDT'),
  series: { '15m': seriesOf('15m'), '1h': seriesOf('1h'), '4h': seriesOf('4h') },
  futures: [],
  btc4h: seriesOf('4h'),
  btc15m: seriesOf('15m'),
  markPrice: 100.5,
  lastPrice: 100.4,
  warmup: DEFAULT_WARMUP,
  ...overrides,
})

describe('buildMarketView: regla de causalidad', () => {
  it('excluye velas con closeTime > t', () => {
    // Caso replay: la serie ya contiene velas futuras y todas vienen cerradas de la
    // historia. A las 10:15 la vela de 4h "vigente" es la que cerró a las 07:59:59.999;
    // la 08:00–12:00 (closeTime 11:59:59.999) todavía no existe para el motor aunque
    // esté marcada `closed: true` en la serie.
    const t = utc(10, 15)
    const velas4h = candleRun('4h', Date.UTC(2026, 9, 30, 0), 9) // 30/10 00:00 … 31/10 08:00
    expect(velas4h.at(-1)).toMatchObject({ openTime: utc(8), closeTime: utc(11, 59, 59, 999), closed: true })

    const view = buildMarketView(inputAt(t, { series: { '15m': seriesOf('15m'), '1h': seriesOf('1h'), '4h': seriesOf('4h', velas4h) } }))

    expect(view.candles['4h'].at(-1)).toMatchObject({ openTime: utc(4), closeTime: utc(7, 59, 59, 999) })
    expect(view.candles['4h']).toHaveLength(8)
    expect(view.candles['4h'].some((c) => c.openTime === utc(8))).toBe(false)
    expect(view.candles['4h'].every((c) => c.closeTime <= t)).toBe(true)
  })

  it('aplica la misma regla en 15m, 1h y 4h', () => {
    // A las 10:15 la última de 15m es la 10:00–10:14:59.999, la de 1h la 09:00–09:59:59.999
    // y la de 4h la 04:00–07:59:59.999.
    const t = utc(10, 15)
    const view = buildMarketView(
      inputAt(t, {
        series: {
          '15m': seriesOf('15m', candleRun('15m', utc(8), 12)), // 08:00 … 10:45
          '1h': seriesOf('1h', candleRun('1h', utc(6), 6)), // 06:00 … 11:00
          '4h': seriesOf('4h', candleRun('4h', utc(0), 4)), // 00:00 … 12:00
        },
      }),
    )
    expect(view.candles['15m'].at(-1)?.openTime).toBe(utc(10, 0))
    expect(view.candles['1h'].at(-1)?.openTime).toBe(utc(9, 0))
    expect(view.candles['4h'].at(-1)?.openTime).toBe(utc(4, 0))
    for (const tf of ['15m', '1h', '4h'] as const) {
      expect(view.candles[tf].every((c) => c.closed && c.closeTime <= t)).toBe(true)
    }
  })

  it('excluye velas no cerradas aunque closeTime ≤ t', () => {
    // Caso vivo: pasó el cierre de la vela de 15m pero el stream todavía no mandó `x = true`.
    const t = utc(10, 15)
    const cerradas = candleRun('15m', utc(8), 8) // 08:00 … 09:45
    const pendiente = candle(utc(10, 0), '15m', { closed: false })
    expect(pendiente.closeTime).toBeLessThanOrEqual(t)

    const view = buildMarketView(inputAt(t, { series: { '15m': seriesOf('15m', [...cerradas, pendiente]), '1h': seriesOf('1h'), '4h': seriesOf('4h') } }))

    expect(view.candles['15m'].at(-1)?.openTime).toBe(utc(9, 45))
    expect(view.candles['15m'].every((c) => c.closed)).toBe(true)
  })

  it('excluye una vela no cerrada en el medio de la serie sin cortar las anteriores', () => {
    const t = utc(10, 15)
    const velas = candleRun('15m', utc(8), 9).map((c) => (c.openTime === utc(9, 0) ? { ...c, closed: false } : c))
    const view = buildMarketView(inputAt(t, { series: { '15m': seriesOf('15m', velas), '1h': seriesOf('1h'), '4h': seriesOf('4h') } }))
    expect(view.candles['15m'].map((c) => c.openTime)).toEqual([utc(8, 0), utc(8, 15), utc(8, 30), utc(8, 45), utc(9, 15), utc(9, 30), utc(9, 45), utc(10, 0)])
  })

  it('futures toma el último snapshot ≤ t', () => {
    const futures = [snapshot(utc(9)), snapshot(utc(10)), snapshot(utc(10, 15)), snapshot(utc(11))]
    expect(buildMarketView(inputAt(utc(10, 15), { futures })).futures?.at).toBe(utc(10, 15))
    expect(buildMarketView(inputAt(utc(10, 14, 59, 999), { futures })).futures?.at).toBe(utc(10))
    expect(buildMarketView(inputAt(utc(12), { futures })).futures?.at).toBe(utc(11))
  })

  it('futures es null si no hay snapshot ≤ t', () => {
    expect(buildMarketView(inputAt(utc(10, 15), { futures: [] })).futures).toBeNull()
    expect(buildMarketView(inputAt(utc(8, 59, 59, 999), { futures: [snapshot(utc(9)), snapshot(utc(10))] })).futures).toBeNull()
  })

  it('respeta el límite de calentamiento (300)', () => {
    const t = utc(10, 15)
    const velas15m = candleRun('15m', utc(10, 0) - 399 * TF_MS['15m'], 400) // 400 velas; la última cierra 10:14:59.999
    const velasBtc4h = candleRun('4h', utc(4) - 349 * TF_MS['4h'], 350) // 350 velas; la última cierra 07:59:59.999
    const view = buildMarketView(inputAt(t, { series: { '15m': seriesOf('15m', velas15m), '1h': seriesOf('1h'), '4h': seriesOf('4h') }, btc4h: seriesOf('4h', velasBtc4h) }))

    expect(view.candles['15m']).toHaveLength(300)
    expect(view.candles['15m'].at(0)?.openTime).toBe(velas15m[100]?.openTime) // quedan las 300 más recientes
    expect(view.candles['15m'].at(-1)?.openTime).toBe(utc(10, 0))
    expect(view.btc.candles4h).toHaveLength(300)
    expect(view.btc.candles4h.at(-1)?.openTime).toBe(utc(4))
  })

  it('copia t, symbol, info y precios tal cual', () => {
    const view = buildMarketView(inputAt(utc(10, 15)))
    expect(view).toMatchObject({ t: utc(10, 15), symbol: 'ETHUSDT', markPrice: 100.5, lastPrice: 100.4 })
    expect(view.info).toEqual(symbolInfo('ETHUSDT'))
  })
})

describe('buildMarketView: contexto de BTC', () => {
  const t = utc(10, 15)
  // 200 velas de 15m de BTC con precio variable hasta las 10:00 y cuatro posteriores a t.
  const btc15m = (): CandleSeries =>
    seriesOf('15m', candleRun('15m', utc(10, 0) - 199 * TF_MS['15m'], 204, (i) => 100 * Math.exp(0.01 * Math.sin(i))))
  const btc4h = (): CandleSeries => seriesOf('4h', candleRun('4h', utc(0), 3)) // 00:00 … 08:00

  it('lo calcula desde btc4h y btc15m con la misma regla de causalidad', () => {
    const view = buildMarketView(inputAt(t, { btc4h: btc4h(), btc15m: btc15m() }))
    expect(view.btc).toEqual(buildBtcContext({ t, btc4h: btc4h(), btc15m: btc15m(), warmup4h: DEFAULT_WARMUP['4h'] }))
    expect(view.btc.realizedVol24h).toBeGreaterThan(0)
    expect(view.btc.candles4h.at(-1)?.openTime).toBe(utc(4))
  })

  it('usa tal cual el contexto precalculado del ciclo si viene', () => {
    const btc: BtcContext = { candles4h: [], realizedVol24h: 0.05, realizedVol30dMean: 0.02 }
    const view = buildMarketView(inputAt(t, { btc, btc4h: btc4h(), btc15m: btc15m() }))
    expect(view.btc).toBe(btc)
  })
})

describe('CandleSeries', () => {
  it('upsert reemplaza la vela del mismo openTime', () => {
    const s = new CandleSeries('15m')
    s.upsert(candle(utc(10, 0), '15m', { close: 100, closed: false }))
    s.upsert(candle(utc(10, 0), '15m', { close: 102, closed: true }))
    expect(s.size).toBe(1)
    expect(s.last()).toMatchObject({ openTime: utc(10, 0), close: 102, closed: true })
    expect(s.closedUpTo(utc(10, 15))).toHaveLength(1)
  })
})
