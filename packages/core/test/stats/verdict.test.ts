import { describe, expect, it } from 'vitest'
import { verdict } from '../../src/stats/verdict'
import { closedFromR, makeClosed } from './fixtures'
import { mulberry32 } from './mulberry32'

const opts = (seed = 1) => ({ minTrades: 100, minDays: 30, maxDrawdownPct: 0.05, rng: mulberry32(seed) })
const repeat = (n: number, value: number) => Array.from({ length: n }, () => value)

describe('verdict', () => {
  it('con 20 trades ⇒ insufficient y faltan 80', () => {
    const v = verdict(closedFromR(repeat(20, 0.5)), 45, opts())
    expect(v.status).toBe('insufficient')
    expect(v.missingTrades).toBe(80)
    expect(v.reason).toBe('Con 20 operaciones todavía no se puede saber si tiene ventaja; faltan 80.')
  })

  it('con 120 trades pero 10 días ⇒ insufficient por días', () => {
    const v = verdict(closedFromR(repeat(120, 0.5)), 10, opts())
    expect(v.status).toBe('insufficient')
    expect(v.missingTrades).toBe(0)
    expect(v.missingDays).toBe(20)
    expect(v.reason).toBe('Con 120 operaciones en 10 días todavía no se puede saber si tiene ventaja; faltan 20 días.')
  })

  it('con 120 trades todos +0,5R ⇒ edge', () => {
    const v = verdict(closedFromR(repeat(120, 0.5)), 45, opts())
    expect(v.status).toBe('edge')
    expect(v.missingTrades).toBeUndefined()
    expect(v.expectancyR).toBeCloseTo(0.5, 10)
    expect(v.ci95).toEqual([0.5, 0.5])
    expect(v.profitFactor).toBe(Number.POSITIVE_INFINITY)
    expect(v.reason).toBe('Con 120 operaciones en 45 días: ventaja positiva (expectativa +0,50R, 95% de confianza).')
  })

  it('con 120 trades alternando +1/−1 ⇒ no_edge porque el intervalo incluye 0', () => {
    const v = verdict(closedFromR(Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 1 : -1))), 45, opts())
    expect(v.status).toBe('no_edge')
    expect(v.expectancyR).toBeCloseTo(0, 10)
    expect(v.ci95[0]).toBeLessThan(0)
    expect(v.ci95[1]).toBeGreaterThan(0)
    expect(v.profitFactor).toBe(1)
    expect(v.reason).toMatch(/intervalo que incluye 0/)
    expect(v.reason).toMatch(/^Con 120 operaciones: sin ventaja demostrada \(/)
  })

  it('mismo rng con semilla ⇒ mismo ci95 en dos corridas', () => {
    const closed = closedFromR(Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? -1 : 0.8)))
    const a = verdict(closed, 45, opts(42))
    const b = verdict(closed, 45, opts(42))
    expect(a.ci95).toEqual(b.ci95)
    expect(a).toEqual(b)
  })

  it('expectativa positiva pero factor de beneficio bajo ⇒ no_edge con la razón', () => {
    // 100 × +0,25R y 20 × −1R: media +0,04R, factor 25/20 = 1,25 < 1,3
    const closed = closedFromR(Array.from({ length: 120 }, (_, i) => (i < 100 ? 0.25 : -1)))
    const v = verdict(closed, 45, opts())
    expect(v.profitFactor).toBeCloseTo(1.25, 10)
    expect(v.status).toBe('no_edge')
    expect(v.reason).toMatch(/factor de beneficio 1,25 < 1,3/)
  })

  it('drawdown por encima del 15% ⇒ no_edge aunque todo lo demás dé ventaja', () => {
    const closed = closedFromR(repeat(120, 0.5))
    const edge = verdict(closed, 45, opts())
    expect(edge.status).toBe('edge')
    expect(edge.maxDrawdownPct).toBe(0.05)

    const v = verdict(closed, 45, { ...opts(), maxDrawdownPct: 0.18 })
    expect(v.status).toBe('no_edge')
    expect(v.maxDrawdownPct).toBe(0.18)
    expect(v.reason).toBe('Con 120 operaciones: sin ventaja demostrada (drawdown máximo 18% > 15%).')
  })

  it('el límite del drawdown es inclusivo: 15% todavía da ventaja, 15,1% ya no', () => {
    const closed = closedFromR(repeat(120, 0.5))
    expect(verdict(closed, 45, { ...opts(), maxDrawdownPct: 0.15 }).status).toBe('edge')
    const v = verdict(closed, 45, { ...opts(), maxDrawdownPct: 0.151 })
    expect(v.status).toBe('no_edge')
    expect(v.reason).toMatch(/drawdown máximo 15,1% > 15%/)
  })

  it('el drawdown es obligatorio: sin él no compila', () => {
    const { maxDrawdownPct: _omitido, ...sinDrawdown } = opts()
    // @ts-expect-error falta maxDrawdownPct: no hay un 0 por defecto que dé una ventaja falsa
    expect(() => verdict(closedFromR(repeat(120, 0.5)), 45, sinDrawdown)).toThrow(RangeError)
  })

  it('un drawdown no medible (NaN, infinito o negativo) se rechaza en vez de aprobar', () => {
    const closed = closedFromR(repeat(120, 0.5))
    for (const maxDrawdownPct of [Number.NaN, Number.POSITIVE_INFINITY, -0.2]) {
      expect(() => verdict(closed, 45, { ...opts(), maxDrawdownPct })).toThrow(RangeError)
    }
  })

  it('un drawdown mayor a 1 es un error de unidades (18 en vez de 0,18): RangeError', () => {
    const closed = closedFromR(repeat(120, 0.5))
    expect(() => verdict(closed, 45, { ...opts(), maxDrawdownPct: 18 })).toThrow(RangeError)
    expect(() => verdict(closed, 45, { ...opts(), maxDrawdownPct: 1.0001 })).toThrow(/fracción/)
    // El 100% es un drawdown posible (la cuenta en cero): no es error, da sin ventaja.
    expect(verdict(closed, 45, { ...opts(), maxDrawdownPct: 1 }).status).toBe('no_edge')
  })

  it('con 20 trades y 10 días ⇒ faltan las dos cosas en una sola frase', () => {
    const v = verdict(closedFromR(repeat(20, 0.5)), 10, opts())
    expect(v.status).toBe('insufficient')
    expect(v.missingTrades).toBe(80)
    expect(v.missingDays).toBe(20)
    expect(v.reason).toBe('Con 20 operaciones en 10 días todavía no se puede saber si tiene ventaja; faltan 80 operaciones y 20 días.')
  })

  it('singulares: 1 operación, 1 día', () => {
    const v = verdict(closedFromR([0.5]), 29, opts())
    expect(v.reason).toBe('Con 1 operación en 29 días todavía no se puede saber si tiene ventaja; faltan 99 operaciones y 1 día.')
    const w = verdict(closedFromR(repeat(20, 0.5)), 1, opts())
    expect(w.reason).toBe('Con 20 operaciones en 1 día todavía no se puede saber si tiene ventaja; faltan 80 operaciones y 29 días.')
  })

  it('días no finitos se rechazan en vez de dar por cumplidos los 30 días', () => {
    const closed = closedFromR(repeat(120, 0.5))
    for (const days of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => verdict(closed, days, opts())).toThrow(RangeError)
    }
  })

  it('días negativos (reloj corrido) cuentan como 0', () => {
    const v = verdict(closedFromR(repeat(120, 0.5)), -2, opts())
    expect(v.status).toBe('insufficient')
    expect(v.missingDays).toBe(30)
    expect(v.reason).toBe('Con 120 operaciones en 0 días todavía no se puede saber si tiene ventaja; faltan 30 días.')
  })

  it('todos los trades negativos ⇒ intervalo por debajo de 0, con el signo menos tipográfico', () => {
    const v = verdict(closedFromR(repeat(120, -0.5)), 45, opts())
    expect(v.status).toBe('no_edge')
    expect(v.ci95).toEqual([-0.5, -0.5])
    expect(v.reason).toBe(
      'Con 120 operaciones: sin ventaja demostrada (expectativa \u22120,50R, intervalo por debajo de 0; factor de beneficio 0 < 1,3).',
    )
  })

  it('una expectativa que redondea a cero no lleva signo', () => {
    // 119 × 0R y 1 × −0,12R: media −0,001R
    const v = verdict(closedFromR([...repeat(119, 0), -0.12]), 45, opts())
    expect(v.status).toBe('no_edge')
    expect(v.reason).toMatch(/expectativa 0,00R, intervalo que incluye 0/)
  })

  it('mezclar posiciones reales y de la sombra es un error', () => {
    const closed = [...closedFromR(repeat(119, 0.5)), makeClosed({ id: 'sombra', rMultiple: 0.5, shadow: true })]
    expect(() => verdict(closed, 45, opts())).toThrow(RangeError)
  })

  it('lo aprendido más de 3 pp por debajo de la sombra ⇒ no_edge', () => {
    const closed = closedFromR(repeat(120, 0.5))
    expect(verdict(closed, 45, { ...opts(), shadowGapPp: -2.5 }).status).toBe('edge')
    const v = verdict(closed, 45, { ...opts(), shadowGapPp: -4.2 })
    expect(v.status).toBe('no_edge')
    expect(v.reason).toMatch(/4,2 pp por debajo de la sombra/)
  })

  it('una diferencia con la sombra no finita se rechaza en vez de aprobar', () => {
    expect(() => verdict(closedFromR(repeat(120, 0.5)), 45, { ...opts(), shadowGapPp: Number.NaN })).toThrow(RangeError)
  })
})
