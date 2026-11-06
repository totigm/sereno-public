import { describe, it, expect } from 'vitest'
import { sma } from '../../src/indicators/sma'
import { fixtureCloses, expected, leadingNaNs } from './synthetic'

describe('sma', () => {
  it('devuelve NaN hasta tener `period` valores y después la media de la ventana', () => {
    const out = sma(fixtureCloses, 5)
    expect(out).toHaveLength(fixtureCloses.length)
    expect(leadingNaNs(out)).toBe(4)
    // A mano: cierres 6..10 = 107 + 103,5 + 107 + 110,5 + 107 = 535; 535 / 5 = 107.
    expect(out[10]).toBeCloseTo(107, 12)
    expect(out[10]).toBeCloseTo(expected.sma5_at10, 12)
  })

  it('con período 1 es la identidad', () => {
    expect(sma([3, 1, 2], 1)).toEqual([3, 1, 2])
  })

  it('devuelve todo NaN si la serie es más corta que el período', () => {
    expect(sma([1, 2, 3], 5).every(Number.isNaN)).toBe(true)
    expect(sma([], 5)).toEqual([])
  })

  it('un NaN dentro de la ventana da NaN sólo en las ventanas que lo contienen', () => {
    const out = sma([1, 2, Number.NaN, 4, 5, 6], 2)
    expect(out.slice(0, 4).map(Number.isNaN)).toEqual([true, false, true, true])
    expect(out[4]).toBe(4.5)
  })

  it('rechaza períodos que no son enteros positivos', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError)
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError)
  })
})
