import { describe, expect, it } from 'vitest'
import { computeComposite } from '../../src/signals/composite'
import { evaluateSignals } from '../../src/signals/index'
import type { Candle, MarketView } from '../../src/types'
import { fullView, snapshot, unitWeights } from './fixtures'

// Contrato de las señales: sin datos devuelven `value: null` (nunca NaN) y nunca lanzan.
const poison = (candles: Candle[], value: number): Candle[] =>
  candles.map((c) => ({ ...c, open: value, high: value, low: value, close: value, volume: value }))

function expectWellFormed(view: MarketView): void {
  for (const s of evaluateSignals(view)) {
    if (s.value !== null) {
      expect(Number.isFinite(s.value)).toBe(true)
      expect(Math.abs(s.value)).toBeLessThanOrEqual(1)
    }
    for (const v of Object.values(s.detail ?? {})) expect(Number.isFinite(v)).toBe(true)
  }
  const c = computeComposite(view, unitWeights)
  for (const v of [c.S, c.Sprime, c.confidence, c.relVolume, c.modifiers.adx, c.modifiers.vol]) expect(Number.isFinite(v)).toBe(true)
}

const FUTURES_SIGNALS = ['funding', 'openInterest', 'positioning']

describe('señales con datos inválidos', () => {
  const base = fullView({ futures: snapshot() })

  it.each([
    ['NaN', Number.NaN],
    ['cero', 0],
    ['negativos', -5],
    ['infinitos', Number.POSITIVE_INFINITY],
  ])('precios y volúmenes %s en todos los marcos: valores null o finitos, sin lanzar', (_name, value) => {
    const view: MarketView = {
      ...base,
      candles: { '15m': poison(base.candles['15m'], value), '1h': poison(base.candles['1h'], value), '4h': poison(base.candles['4h'], value) },
      btc: { ...base.btc, candles4h: poison(base.btc.candles4h, value) },
    }
    expectWellFormed(view)
  })

  it.each([
    ['NaN', Number.NaN],
    ['cero', 0],
    ['negativos', -1],
  ])('datos de futuros %s: valores null o finitos, sin lanzar', (_name, value) => {
    const futures = snapshot({ fundingRate: value, openInterest: value, openInterest1hAgo: value, openInterest4hAgo: value, longShortRatio: value, takerRatio: value })
    expectWellFormed({ ...base, futures })
  })

  it('datos de futuros NaN cuentan como faltantes', () => {
    const nan = Number.NaN
    const futures = snapshot({ fundingRate: nan, openInterest: nan, openInterest1hAgo: nan, openInterest4hAgo: nan, longShortRatio: nan, takerRatio: nan })
    const values = evaluateSignals({ ...base, futures }).filter((s) => FUTURES_SIGNALS.includes(s.id))
    expect(values.map((s) => s.value)).toEqual([null, null, null])
    expect(computeComposite({ ...base, futures }, unitWeights).missing).toEqual(FUTURES_SIGNALS)
  })

  it('un cierre NaN en la última vela de 15m deja sin dato a las señales de 15m', () => {
    const c15m = base.candles['15m'].map((c, i, all) => (i === all.length - 1 ? { ...c, close: Number.NaN } : c))
    const byId = Object.fromEntries(evaluateSignals({ ...base, candles: { ...base.candles, '15m': c15m } }).map((s) => [s.id, s.value]))
    expect(byId).toMatchObject({ trend15m: null, momentum: null, breakout: null, bands: null, vwap: null })
  })
})
