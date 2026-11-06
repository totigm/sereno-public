import { describe, it, expect } from 'vitest'
import { macd } from '../../src/indicators/macd'
import { fixtureCloses, expected, constantSeries, leadingNaNs } from './synthetic'

describe('macd', () => {
  it('con una serie constante el histograma es 0', () => {
    const out = macd(constantSeries(60), 12, 26, 9)
    expect(out.histogram.slice(33).every((v) => v === 0)).toBe(true)
    expect(out.macd.slice(25).every((v) => v === 0)).toBe(true)
  })

  it('calienta 25 velas para la línea MACD y 33 para la señal', () => {
    const out = macd(fixtureCloses, 12, 26, 9)
    expect(out.macd).toHaveLength(60)
    expect(out.signal).toHaveLength(60)
    expect(out.histogram).toHaveLength(60)
    expect(leadingNaNs(out.macd)).toBe(25)
    expect(leadingNaNs(out.signal)).toBe(33)
    expect(leadingNaNs(out.histogram)).toBe(33)
  })

  it('coincide con el oráculo en el fixture (índices 33 y 40)', () => {
    const out = macd(fixtureCloses, 12, 26, 9)
    expect(out.macd[33]).toBeCloseTo(expected.macd_at33.macd, 10)
    expect(out.signal[33]).toBeCloseTo(expected.macd_at33.signal, 10)
    expect(out.histogram[33]).toBeCloseTo(expected.macd_at33.histogram, 10)
    expect(out.macd[40]).toBeCloseTo(expected.macd_at40.macd, 10)
    expect(out.signal[40]).toBeCloseTo(expected.macd_at40.signal, 10)
    expect(out.histogram[40]).toBeCloseTo(expected.macd_at40.histogram, 10)
  })

  it('los parámetros por defecto son 12, 26, 9', () => {
    expect(macd(fixtureCloses)).toEqual(macd(fixtureCloses, 12, 26, 9))
  })

  it('rechaza un período rápido que no sea menor que el lento', () => {
    expect(() => macd(fixtureCloses, 26, 12, 9)).toThrow(RangeError)
    expect(() => macd(fixtureCloses, 12, 12, 9)).toThrow(RangeError)
  })
})
