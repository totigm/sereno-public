import { describe, it, expect } from 'vitest'
import { ema } from '../../src/indicators/ema'
import { fixtureCloses, expected, leadingNaNs } from './synthetic'

describe('ema', () => {
  it('usa la SMA de los primeros `period` valores como semilla', () => {
    const out = ema(fixtureCloses, 5)
    expect(out).toHaveLength(fixtureCloses.length)
    expect(leadingNaNs(out)).toBe(4)
    // A mano: (100 + 103,5 + 107 + 103,5 + 107) / 5 = 521 / 5 = 104,2.
    expect(out[4]).toBeCloseTo(104.2, 12)
    expect(out[4]).toBeCloseTo(expected.ema5_at4, 12)
  })

  it('en el índice 10 coincide con la recursión α = 2/(5+1) = 1/3 calculada a mano', () => {
    // s5  = 104,2 + (103,5 − 104,2)/3 = 103,9666…
    // s6  = 103,9666… + (107 − 103,9666…)/3 = 104,9777…
    // s7  = 104,4851…   s8 = 105,3234…   s9 = 107,0489…
    // s10 = 107,0489… + (107 − 107,0489…)/3 = 107,0326… (exacto: 390134/3645)
    const out = ema(fixtureCloses, 5)
    expect(out[10]).toBeCloseTo(390134 / 3645, 12)
    expect(out[10]).toBeCloseTo(expected.ema5_at10, 12)
  })

  it('una serie constante da la constante desde la semilla', () => {
    const out = ema([7, 7, 7, 7, 7, 7], 3)
    expect(out.slice(2)).toEqual([7, 7, 7, 7])
  })

  it('salta los NaN iniciales para poder encadenar indicadores (MACD → señal)', () => {
    const out = ema([Number.NaN, Number.NaN, 1, 3, 5, 7], 2)
    expect(leadingNaNs(out)).toBe(3)
    expect(out[3]).toBeCloseTo(2, 12) // semilla = (1 + 3) / 2
    expect(out[4]).toBeCloseTo(2 + (2 / 3) * (5 - 2), 12)
  })

  it('devuelve todo NaN si no alcanza para la semilla', () => {
    expect(ema([1, 2], 3).every(Number.isNaN)).toBe(true)
  })

  it('rechaza períodos inválidos', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError)
  })
})
