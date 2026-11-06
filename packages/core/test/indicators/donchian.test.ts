import { describe, it, expect } from 'vitest'
import { donchian } from '../../src/indicators/donchian'
import { fixtureCandles, expected, candleAt, leadingNaNs } from './synthetic'

describe('donchian (excluye la vela actual)', () => {
  it('en la vela 21 (cierre 110 sobre máximos previos de 105) devuelve upper[20] = 105, no 110', () => {
    // 20 velas con máximos 100..105 (ciclo de 6) y mínimos 90..95; la vela 21 rompe.
    const previous = Array.from({ length: 20 }, (_, i) =>
      candleAt(i, { open: 100, high: 100 + (i % 6), low: 90 + (i % 6), close: 100 }),
    )
    const breakout = candleAt(20, { open: 100, high: 111, low: 99, close: 110 })
    const out = donchian([...previous, breakout], 20)
    expect(out.upper).toHaveLength(21)
    expect(leadingNaNs(out.upper)).toBe(20)
    expect(leadingNaNs(out.lower)).toBe(20)
    expect(out.upper[20]).toBe(105)
    expect(out.lower[20]).toBe(90)
  })

  it('la ventana se desplaza: en i = 21 ya no incluye la vela 0 y sí la vela 20', () => {
    const candles = Array.from({ length: 22 }, (_, i) => candleAt(i, { open: 100, high: 100 + i, low: 100 - i, close: 100 }))
    const out = donchian(candles, 20)
    expect(out.upper[20]).toBe(119) // velas 0..19
    expect(out.upper[21]).toBe(120) // velas 1..20
    expect(out.lower[21]).toBe(80)
  })

  it('coincide con el oráculo en el fixture (índice 30)', () => {
    const out = donchian(fixtureCandles, 20)
    expect(out.upper[30]).toBe(expected.donchian20_at30.upper)
    expect(out.lower[30]).toBe(expected.donchian20_at30.lower)
  })

  it('el período por defecto es 20', () => {
    expect(donchian(fixtureCandles)).toEqual(donchian(fixtureCandles, 20))
  })
})
