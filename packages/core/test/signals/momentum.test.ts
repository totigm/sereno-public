import { describe, expect, it } from 'vitest'
import { momentum, momentumValue } from '../../src/signals/momentum'
import { run, up, viewOf } from './fixtures'

describe('momentumValue', () => {
  it('RSI 80 con MACD positivo vale menos que RSI 60 (sobrecompra resta)', () => {
    const overbought = momentumValue({ rsi: 80, histogram: 0.5, atr: 1 })
    const confirming = momentumValue({ rsi: 60, histogram: 0.5, atr: 1 })
    expect(overbought).toBeLessThan(confirming)
    expect(confirming).toBeCloseTo(0.2 + 0.25, 12)
    expect(overbought).toBeCloseTo(-0.1 + 0.25, 12)
  })

  it('RSI 20 vale más que RSI 30 (sobreventa resta al short)', () => {
    expect(momentumValue({ rsi: 20, histogram: 0, atr: 1 })).toBeGreaterThan(momentumValue({ rsi: 30, histogram: 0, atr: 1 }))
  })

  it('neutro: RSI 50 e histograma 0', () => {
    expect(momentumValue({ rsi: 50, histogram: 0, atr: 1 })).toBe(0)
  })

  it('cada mitad se recorta a ±1 antes de pesar 0,5', () => {
    expect(momentumValue({ rsi: 75, histogram: 3, atr: 1 })).toBe(1)
    expect(momentumValue({ rsi: 25, histogram: -3, atr: 1 })).toBe(-1)
    expect(momentumValue({ rsi: 50, histogram: 0.25, atr: 1 })).toBeCloseTo(0.125, 12)
  })

  it('es antisimétrico: f(rsi, h) = −f(100 − rsi, −h)', () => {
    for (const [rsi, h] of [
      [60, 0.5],
      [80, 0.5],
      [90, -0.2],
      [10, 0.1],
    ] as const) {
      expect(momentumValue({ rsi, histogram: h, atr: 1 })).toBeCloseTo(-momentumValue({ rsi: 100 - rsi, histogram: -h, atr: 1 }), 12)
    }
  })

  it('con ATR 0 el MACD no aporta', () => {
    expect(momentumValue({ rsi: 60, histogram: 0, atr: 0 })).toBeCloseTo(0.2, 12)
  })
})

describe('momentum (vista)', () => {
  it('tiene valor y detalle con historia suficiente', () => {
    const r = momentum(viewOf({ c15m: run('15m', 100, up, { halfRange: 1 }) }))
    expect(r.id).toBe('momentum')
    expect(r.value).not.toBeNull()
    expect(r.detail).toMatchObject({ rsi: 100, histogram: expect.any(Number), atr: expect.any(Number) })
  })

  it('null mientras el MACD calienta (34 velas) o sin velas', () => {
    expect(momentum(viewOf({ c15m: run('15m', 33, up, { halfRange: 1 }) })).value).toBeNull()
    expect(momentum(viewOf()).value).toBeNull()
  })
})
