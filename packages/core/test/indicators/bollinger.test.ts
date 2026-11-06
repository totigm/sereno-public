import { describe, it, expect } from 'vitest'
import { bollinger } from '../../src/indicators/bollinger'
import { fixtureCloses, expected, constantSeries, leadingNaNs } from './synthetic'

describe('bollinger', () => {
  it('una serie constante da banda cero (upper = middle = lower)', () => {
    const out = bollinger(constantSeries(30, 100), 20, 2)
    expect(out.upper[25]).toBe(100)
    expect(out.middle[25]).toBe(100)
    expect(out.lower[25]).toBe(100)
    // Sin ancho de banda no hay posición dentro de ella.
    expect(Number.isNaN(out.pctB[25])).toBe(true)
  })

  it('calienta `period` − 1 velas en las cuatro series', () => {
    const out = bollinger(fixtureCloses, 20, 2)
    for (const series of [out.upper, out.middle, out.lower, out.pctB]) {
      expect(series).toHaveLength(60)
      expect(leadingNaNs(series)).toBe(19)
    }
  })

  it('coincide con el oráculo en el fixture (índice 30, desvío poblacional)', () => {
    const out = bollinger(fixtureCloses, 20, 2)
    expect(out.middle[30]).toBeCloseTo(expected.bollinger20_at30.middle, 10)
    expect(out.upper[30]).toBeCloseTo(expected.bollinger20_at30.upper, 10)
    expect(out.lower[30]).toBeCloseTo(expected.bollinger20_at30.lower, 10)
    expect(out.pctB[30]).toBeCloseTo(expected.bollinger20_at30.pctB, 10)
  })

  it('pctB es 0 en la banda inferior, 1 en la superior y 0,5 en la media', () => {
    // Ventanas de 5 con media 10 y desvío poblacional 1 exactos: bandas 8 y 12 con mult 2.
    const onLower = bollinger([10.5, 10.5, 10.5, 10.5, 8], 5, 2)
    const onMiddle = bollinger([11.5, 8.5, 10.5, 9.5, 10], 5, 2)
    const onUpper = bollinger([9.5, 9.5, 9.5, 9.5, 12], 5, 2)
    for (const out of [onLower, onMiddle, onUpper]) {
      expect(out.lower[4]).toBe(8)
      expect(out.middle[4]).toBe(10)
      expect(out.upper[4]).toBe(12)
    }
    expect(onLower.pctB[4]).toBe(0)
    expect(onMiddle.pctB[4]).toBe(0.5)
    expect(onUpper.pctB[4]).toBe(1)
  })

  it('los parámetros por defecto son 20 y 2', () => {
    expect(bollinger(fixtureCloses)).toEqual(bollinger(fixtureCloses, 20, 2))
  })
})
