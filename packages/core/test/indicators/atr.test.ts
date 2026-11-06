import { describe, it, expect } from 'vitest'
import { atr, trueRange } from '../../src/indicators/atr'
import { fixtureCandles, expected, flatCandles, candleAt, leadingNaNs } from './synthetic'

describe('atr (Wilder)', () => {
  it('con velas de rango constante 2 vale 2', () => {
    const out = atr(flatCandles(30, 100, 1), 14)
    expect(out).toHaveLength(30)
    // El rango verdadero necesita el cierre anterior: empieza en el índice 1,
    // y el ATR en el índice `period`.
    expect(leadingNaNs(out)).toBe(14)
    expect(out[14]).toBe(2)
    expect(out[29]).toBe(2)
  })

  it('el rango verdadero incluye el hueco contra el cierre anterior', () => {
    const candles = [
      candleAt(0, { open: 100, high: 101, low: 99, close: 100 }),
      candleAt(1, { open: 110, high: 111, low: 109, close: 110 }), // hueco de 10 al alza
      candleAt(2, { open: 110, high: 111, low: 95, close: 96 }), // mecha larga
    ]
    const tr = trueRange(candles)
    expect(Number.isNaN(tr[0])).toBe(true)
    expect(tr[1]).toBe(11) // max(111 − 109, |111 − 100|, |109 − 100|)
    expect(tr[2]).toBe(16) // max(111 − 95, |111 − 110|, |95 − 110|)
  })

  it('coincide con el oráculo en el fixture (índices 14 y 20)', () => {
    const out = atr(fixtureCandles, 14)
    expect(out[14]).toBeCloseTo(expected.atr14_at14, 10)
    expect(out[20]).toBeCloseTo(expected.atr14_at20, 10)
  })

  it('el período por defecto es 14', () => {
    expect(atr(fixtureCandles)).toEqual(atr(fixtureCandles, 14))
  })
})
