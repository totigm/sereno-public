import { describe, it, expect } from 'vitest'
import { realizedVol } from '../../src/indicators/realized-vol'
import { fixtureCloses, expected, constantSeries, leadingNaNs } from './synthetic'

describe('realizedVol', () => {
  it('una serie constante tiene volatilidad 0', () => {
    const out = realizedVol(constantSeries(30), 24)
    expect(out[29]).toBe(0)
  })

  it('necesita `window` retornos, o sea window + 1 cierres: NaN hasta el índice window − 1', () => {
    const out = realizedVol(fixtureCloses, 24)
    expect(out).toHaveLength(60)
    expect(leadingNaNs(out)).toBe(24)
  })

  it('coincide con el oráculo: desvío muestral de log-retornos × √(velas por día)', () => {
    // Velas de 1h: 24 velas por día; por defecto `candlesPerDay` = `window`.
    const out = realizedVol(fixtureCloses, 24, 24)
    expect(out[30]).toBeCloseTo(expected.realizedVol24_at30, 12)
    expect(realizedVol(fixtureCloses, 24)[30]).toBeCloseTo(expected.realizedVol24_at30, 12)
  })

  it('escala con la raíz de las velas por día', () => {
    const daily = realizedVol(fixtureCloses, 24, 24)[30]!
    expect(realizedVol(fixtureCloses, 24, 96)[30]).toBeCloseTo(daily * 2, 12)
  })

  it('a mano: retornos alternados ±ln 2 con ventana 2 y 1 vela por día', () => {
    // cierres 1, 2, 1: retornos ln 2 y −ln 2; media 0; varianza muestral = (2·ln²2) / 1.
    const out = realizedVol([1, 2, 1], 2, 1)
    expect(out[2]).toBeCloseTo(Math.SQRT2 * Math.LN2, 12)
  })

  it('un cierre no positivo contamina las ventanas que lo contienen', () => {
    // El 0 en el índice 2 rompe los retornos 2 (numerador) y 3 (denominador):
    // con ventana 2 quedan contaminados los índices 2, 3 y 4.
    const out = realizedVol([1, 2, 0, 2, 3, 4, 5], 2, 1)
    expect(Number.isNaN(out[2])).toBe(true)
    expect(Number.isNaN(out[3])).toBe(true)
    expect(Number.isNaN(out[4])).toBe(true)
    expect(Number.isNaN(out[5])).toBe(false)
  })

  it('rechaza ventanas menores a 2', () => {
    expect(() => realizedVol(fixtureCloses, 1)).toThrow(RangeError)
  })
})
