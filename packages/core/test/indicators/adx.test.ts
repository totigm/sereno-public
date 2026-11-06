import { describe, it, expect } from 'vitest'
import { adx } from '../../src/indicators/adx'
import { fixtureCandles, expected, linearTrendCandles, flatCandles, leadingNaNs } from './synthetic'

describe('adx (Wilder)', () => {
  it('una tendencia perfectamente lineal da ADX > 25 después de 30 velas', () => {
    const out = adx(linearTrendCandles(40, 100, 1), 14)
    expect(out).toHaveLength(40)
    expect(out[30]).toBeGreaterThan(25)
    // Sin movimiento en contra (−DM = 0) el DX es 100 en cada vela, y el ADX también.
    expect(out[30]).toBeCloseTo(100, 10)
  })

  it('calienta 2·period − 1 velas (DI desde `period`, ADX desde 2·period − 1)', () => {
    expect(leadingNaNs(adx(fixtureCandles, 14))).toBe(27)
  })

  it('velas planas (sin movimiento direccional) dan 0', () => {
    const out = adx(flatCandles(40, 100, 1), 14)
    expect(out[39]).toBe(0)
  })

  it('coincide con el oráculo en el fixture (índices 27 y 40)', () => {
    const out = adx(fixtureCandles, 14)
    expect(out[27]).toBeCloseTo(expected.adx14_at27, 9)
    expect(out[40]).toBeCloseTo(expected.adx14_at40, 9)
  })

  it('el período por defecto es 14', () => {
    expect(adx(fixtureCandles)).toEqual(adx(fixtureCandles, 14))
  })
})
