import { describe, expect, it } from 'vitest'
import { adx } from '../../src/indicators/adx'
import { computeComposite } from '../../src/signals/composite'
import { evaluateSignals } from '../../src/signals/index'
import { signalRecord } from '../../src/learning/state'
import { SIGNAL_IDS, type SignalId } from '../../src/types'
import { choppy, down, fullView, run, unitWeights, up, viewOf } from './fixtures'

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

describe('computeComposite: puntaje sobre señales disponibles', () => {
  // Sin datos de futuros faltan exactamente funding, openInterest y positioning.
  const view = fullView()

  it('con 10 señales de peso 1 y 3 en null, S es el promedio de las 7 disponibles', () => {
    const c = computeComposite(view, unitWeights)
    const available = c.signals.filter((s) => s.value !== null)
    expect(available).toHaveLength(7)
    expect(c.S).toBeCloseTo(mean(available.map((s) => s.value as number)), 12)
    // No es el promedio sobre 10 (los null no entran al denominador).
    expect(c.S).not.toBeCloseTo(mean(available.map((s) => s.value as number)) * (7 / 10), 6)
  })

  it('missing lista las 3 que faltan y signals viene en el orden canónico', () => {
    const c = computeComposite(view, unitWeights)
    expect(c.missing).toEqual(['funding', 'openInterest', 'positioning'])
    expect(c.signals.map((s) => s.id)).toEqual([...SIGNAL_IDS])
    expect(c.signals).toEqual(evaluateSignals(view))
  })

  it('pondera por los pesos y devuelve los pesos efectivos recibidos', () => {
    const weights = { ...unitWeights, trend15m: 2, bands: 0.5 }
    const c = computeComposite(view, weights)
    const expected = c.signals.reduce(
      (acc, s) => (s.value === null ? acc : { num: acc.num + weights[s.id] * s.value, den: acc.den + weights[s.id] }),
      { num: 0, den: 0 },
    )
    expect(c.S).toBeCloseTo(expected.num / expected.den, 12)
    expect(c.weights).toEqual(weights)
  })

  it('confianza = |S|, S′ = S × mADX × mVol', () => {
    const c = computeComposite(view, unitWeights)
    expect(c.confidence).toBeCloseTo(Math.abs(c.S), 12)
    expect(c.Sprime).toBeCloseTo(c.S * c.modifiers.adx * c.modifiers.vol, 12)
  })

  it('sin ninguna señal disponible: S = 0 y las 10 en missing', () => {
    const c = computeComposite(viewOf(), unitWeights)
    expect(c.S).toBe(0)
    expect(c.Sprime).toBe(0)
    expect(c.confidence).toBe(0)
    expect(c.missing).toEqual([...SIGNAL_IDS])
  })

  it('un peso no finito o negativo cuenta como 0 (la señal no entra) sin volverla missing', () => {
    const weights: Record<SignalId, number> = { ...unitWeights, trend15m: Number.NaN, vwap: -1 }
    const c = computeComposite(view, weights)
    expect(Number.isFinite(c.S)).toBe(true)
    expect(c.missing).toEqual(['funding', 'openInterest', 'positioning'])
    const expected = c.signals.reduce(
      (acc, s) => (s.value === null || s.id === 'trend15m' || s.id === 'vwap' ? acc : { num: acc.num + s.value, den: acc.den + 1 }),
      { num: 0, den: 0 },
    )
    expect(c.S).toBeCloseTo(expected.num / expected.den, 12)
  })
})

describe('computeComposite: modificadores', () => {
  it('mADX = 0,5 con ADX < 20 (serie sin tendencia)', () => {
    const c15m = run('15m', 300, choppy, { halfRange: 0.5 })
    const adxLast = adx(c15m, 14).at(-1) as number
    expect(adxLast).toBeLessThan(20)
    const c = computeComposite(fullView({ c15m }), unitWeights)
    expect(c.modifiers.adx).toBe(0.5)
  })

  it('mADX = 1 con ADX entre 20 y 40 (zigzag con deriva)', () => {
    const c15m = run('15m', 300, (i) => choppy(i) + 0.25 * i, { halfRange: 0.5 })
    const adxLast = adx(c15m, 14).at(-1) as number
    expect(adxLast).toBeGreaterThan(20)
    expect(adxLast).toBeLessThan(40)
    const c = computeComposite(fullView({ c15m }), unitWeights)
    expect(c.modifiers.adx).toBe(1)
  })

  it('mADX = 1,1 con ADX > 40 (tendencia sostenida)', () => {
    const c15m = run('15m', 300, up, { halfRange: 1 })
    expect(adx(c15m, 14).at(-1)).toBeGreaterThan(40)
    const c = computeComposite(fullView({ c15m }), unitWeights)
    expect(c.modifiers.adx).toBe(1.1)
  })

  it('mVol = 1,2 con volumen relativo 3', () => {
    const c15m = run('15m', 300, up, { halfRange: 1, volumeOf: (i) => (i === 299 ? 30 : 10) })
    const c = computeComposite(fullView({ c15m }), unitWeights)
    expect(c.relVolume).toBe(3)
    expect(c.modifiers.vol).toBe(1.2)
  })

  it('mVol = 0,7 con volumen relativo 0,5', () => {
    const c15m = run('15m', 300, up, { halfRange: 1, volumeOf: (i) => (i === 299 ? 5 : 10) })
    const c = computeComposite(fullView({ c15m }), unitWeights)
    expect(c.relVolume).toBe(0.5)
    expect(c.modifiers.vol).toBe(0.7)
  })

  it('S′ queda recortado a ±1', () => {
    const c15m = run('15m', 300, up, { halfRange: 1, volumeOf: (i) => (i === 299 ? 30 : 10) })
    // Sólo pesa la tendencia 15m (+1): S = 1, mADX = 1,1 (tendencia fuerte), mVol = 1,2 ⇒ 1,32 sin tope.
    const onlyTrend = { ...signalRecord(0), trend15m: 1 }
    const c = computeComposite(fullView({ c15m }), onlyTrend)
    expect(c.S).toBe(1)
    expect(c.S * c.modifiers.adx * c.modifiers.vol).toBeGreaterThan(1)
    expect(c.Sprime).toBe(1)
  })

  it('S = 0 si todas las señales disponibles pesan 0', () => {
    const c = computeComposite(fullView(), signalRecord(0))
    expect(c.S).toBe(0)
    expect(c.Sprime).toBe(0)
    expect(c.missing).toEqual(['funding', 'openInterest', 'positioning'])
  })

  it('sin 96 velas previas el volumen relativo es neutro (1)', () => {
    const c = computeComposite(viewOf({ c15m: run('15m', 50, up) }), unitWeights)
    expect(c.relVolume).toBe(1)
    expect(c.modifiers.vol).toBe(1)
  })
})

describe('computeComposite: tendencia mayor en contra', () => {
  // 15m alcista con pequeñas correcciones (RSI ≈ 67, sin sobrecompra).
  const up15m = run('15m', 300, (i) => up(i) + (i % 2 === 0 ? 0 : 1.5), { halfRange: 1 })

  it('higherTrendAgainst = 2 cuando S > 0 y 1h y 4h son bajistas', () => {
    const c = computeComposite(fullView({ c15m: up15m, c1h: run('1h', 300, down), c4h: run('4h', 300, down) }), unitWeights)
    expect(c.S).toBeGreaterThan(0)
    expect(c.higherTrendAgainst).toBe(2)
  })

  it('1 cuando sólo un marco está en contra', () => {
    const c = computeComposite(fullView({ c15m: up15m, c1h: run('1h', 300, up), c4h: run('4h', 300, down) }), unitWeights)
    expect(c.S).toBeGreaterThan(0)
    expect(c.higherTrendAgainst).toBe(1)
  })

  it('0 cuando ambos acompañan, cuando S = 0 o cuando falta el dato', () => {
    expect(computeComposite(fullView({ c15m: up15m }), unitWeights).higherTrendAgainst).toBe(0)
    expect(computeComposite(viewOf(), unitWeights).higherTrendAgainst).toBe(0)
    expect(computeComposite(fullView({ c15m: up15m, c1h: [], c4h: [] }), unitWeights).higherTrendAgainst).toBe(0)
  })

  it('cuenta contra el lado de S también para shorts', () => {
    const down15m = run('15m', 300, (i) => down(i) - (i % 2 === 0 ? 0 : 1.5), { halfRange: 1 })
    // El espejo del caso long: también BTC bajista, para que S quede del lado short.
    const btc = { candles4h: run('4h', 300, down), realizedVol24h: null, realizedVol30dMean: null }
    const c = computeComposite(fullView({ c15m: down15m, c1h: run('1h', 300, up), c4h: run('4h', 300, up), btc }), unitWeights)
    expect(c.S).toBeLessThan(0)
    expect(c.higherTrendAgainst).toBe(2)
  })
})
