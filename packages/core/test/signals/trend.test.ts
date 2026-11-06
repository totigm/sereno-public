import { describe, expect, it } from 'vitest'
import { ema } from '../../src/indicators/ema'
import { btcRegime } from '../../src/signals/btc-regime'
import { emaTrendScore } from '../../src/signals/ema-trend'
import { trend15m } from '../../src/signals/trend-15m'
import { higherTrendScores, trendHigher } from '../../src/signals/trend-higher'
import { down, run, up, viewOf } from './fixtures'

describe('emaTrendScore', () => {
  it('+1 cuando EMA20 > EMA50 > EMA200 con pendiente positiva', () => {
    expect(emaTrendScore(run('15m', 300, up).map((c) => c.close))).toBe(1)
  })

  it('−1 en el caso simétrico', () => {
    expect(emaTrendScore(run('15m', 300, down).map((c) => c.close))).toBe(-1)
  })

  it('intermedio proporcional a las condiciones que se cumplen', () => {
    // 280 velas subiendo y 20 bajando fuerte: la EMA20 ya gira pero la EMA200 queda lejos.
    const closes = run('15m', 300, (i) => (i < 280 ? up(i) : up(279) - 2 * (i - 279))).map((c) => c.close)
    const e20 = ema(closes, 20)
    const e50 = ema(closes, 50)
    const e200 = ema(closes, 200)
    const last = closes.length - 1
    const cond = (bull: boolean, bear: boolean): number => (bull ? 1 : 0) - (bear ? 1 : 0)
    const expected =
      (cond(e20[last]! > e50[last]!, e20[last]! < e50[last]!) +
        cond(e50[last]! > e200[last]!, e50[last]! < e200[last]!) +
        cond(e20[last]! > e20[last - 1]!, e20[last]! < e20[last - 1]!)) /
      3
    expect(Math.abs(expected)).toBeLessThan(1)
    expect(emaTrendScore(closes)).toBeCloseTo(expected, 12)
  })

  it('0 en una serie plana (ninguna condición se cumple en ningún sentido)', () => {
    expect(emaTrendScore(run('15m', 300, () => 100).map((c) => c.close))).toBe(0)
  })

  it('null sin 200 cierres para la EMA200', () => {
    expect(emaTrendScore(run('15m', 199, up).map((c) => c.close))).toBeNull()
    expect(emaTrendScore([])).toBeNull()
  })
})

describe('trend15m', () => {
  it('+1 con tendencia alcista en 15m y detalle de las EMAs', () => {
    const r = trend15m(viewOf({ c15m: run('15m', 300, up) }))
    expect(r.id).toBe('trend15m')
    expect(r.value).toBe(1)
    expect(r.detail).toMatchObject({ ema20: expect.any(Number), ema50: expect.any(Number), ema200: expect.any(Number) })
  })

  it('−1 con tendencia bajista', () => {
    expect(trend15m(viewOf({ c15m: run('15m', 300, down) })).value).toBe(-1)
  })

  it('null sin velas suficientes', () => {
    expect(trend15m(viewOf({ c15m: run('15m', 150, up) })).value).toBeNull()
    expect(trend15m(viewOf()).value).toBeNull()
  })
})

describe('trendHigher', () => {
  it('promedia 1h y 4h', () => {
    expect(trendHigher(viewOf({ c1h: run('1h', 300, up), c4h: run('4h', 300, up) })).value).toBe(1)
    expect(trendHigher(viewOf({ c1h: run('1h', 300, up), c4h: run('4h', 300, down) })).value).toBe(0)
    expect(trendHigher(viewOf({ c1h: run('1h', 300, down), c4h: run('4h', 300, down) })).value).toBe(-1)
  })

  it('null si falta cualquiera de los dos marcos', () => {
    expect(trendHigher(viewOf({ c1h: run('1h', 300, up), c4h: run('4h', 50, up) })).value).toBeNull()
    expect(trendHigher(viewOf({ c1h: [], c4h: run('4h', 300, up) })).value).toBeNull()
  })

  it('higherTrendScores expone cada marco por separado', () => {
    expect(higherTrendScores(viewOf({ c1h: run('1h', 300, up), c4h: run('4h', 50, down) }))).toEqual({ '1h': 1, '4h': null })
  })
})

describe('btcRegime', () => {
  const btcUp = { candles4h: run('4h', 300, up), realizedVol24h: null, realizedVol30dMean: null }
  const btcDown = { candles4h: run('4h', 300, down), realizedVol24h: null, realizedVol30dMean: null }

  it('0 para BTCUSDT', () => {
    const r = btcRegime(viewOf({ symbol: 'BTCUSDT', btc: btcUp }))
    expect(r.id).toBe('btcRegime')
    expect(r.value).toBe(0)
    // BTC no se compara consigo mismo: 0 aunque falte su historia de 4h.
    expect(btcRegime(viewOf({ symbol: 'BTCUSDT' })).value).toBe(0)
  })

  it('proporcional a la tendencia de BTC en el medio (0,5 × puntaje EMA de 4h)', () => {
    const closes = run('4h', 300, (i) => (i < 280 ? up(i) : up(279) - 2 * (i - 279)))
    const value = btcRegime(viewOf({ btc: { ...btcUp, candles4h: closes } })).value
    expect(value).toBeCloseTo(0.5 * (emaTrendScore(closes.map((c) => c.close)) as number), 12)
    expect(Math.abs(value as number)).toBeLessThan(0.5)
  })

  it('+0,5 para alts con BTC alcista en 4h, −0,5 bajista', () => {
    expect(btcRegime(viewOf({ btc: btcUp })).value).toBe(0.5)
    expect(btcRegime(viewOf({ btc: btcDown })).value).toBe(-0.5)
  })

  it('null si las velas de 4h de BTC no alcanzan', () => {
    expect(btcRegime(viewOf({ btc: { ...btcUp, candles4h: run('4h', 100, up) } })).value).toBeNull()
    expect(btcRegime(viewOf()).value).toBeNull()
  })
})
