import { describe, it, expect } from 'vitest'
import { rsi } from '../../src/indicators/rsi'
import { fixtureCloses, expected, linearSeries, constantSeries, leadingNaNs } from './synthetic'

describe('rsi (Wilder)', () => {
  it('una serie que sube 14 veces seguidas da 100 en el índice 14', () => {
    const out = rsi(linearSeries(20, 100, 1), 14)
    expect(out).toHaveLength(20)
    expect(leadingNaNs(out)).toBe(14)
    expect(out[14]).toBe(100)
    expect(out[19]).toBe(100)
  })

  it('una serie que baja 14 veces seguidas da 0', () => {
    expect(rsi(linearSeries(16, 100, -1), 14)[14]).toBe(0)
  })

  it('una serie constante (sin subas ni bajas) da 50, el valor neutro', () => {
    expect(rsi(constantSeries(16), 14)[15]).toBe(50)
  })

  it('el período por defecto es 14', () => {
    expect(rsi(fixtureCloses)).toEqual(rsi(fixtureCloses, 14))
  })

  it('coincide con el oráculo en el fixture (índice 20)', () => {
    const out = rsi(fixtureCloses, 14)
    expect(out[20]).toBeCloseTo(expected.rsi14_at20, 10)
    expect(out[20]).toBeCloseTo(792904625 / 13176688, 10)
  })

  it('siempre queda entre 0 y 100', () => {
    for (const v of rsi(fixtureCloses, 14)) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })
})
