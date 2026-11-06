import { describe, expect, it } from 'vitest'
import { bootstrapMeanCi } from '../../src/stats/bootstrap'
import { mulberry32 } from './mulberry32'

const mixed = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? -1 : 0.8))

describe('bootstrapMeanCi', () => {
  it('misma semilla ⇒ mismo intervalo en dos corridas', () => {
    const a = bootstrapMeanCi(mixed, { rng: mulberry32(7), resamples: 2000 })
    const b = bootstrapMeanCi(mixed, { rng: mulberry32(7), resamples: 2000 })
    expect(a).toEqual(b)
  })

  it('distinta semilla ⇒ intervalo distinto (el rng se usa de verdad)', () => {
    const a = bootstrapMeanCi(mixed, { rng: mulberry32(7), resamples: 2000 })
    const b = bootstrapMeanCi(mixed, { rng: mulberry32(8), resamples: 2000 })
    expect(a).not.toEqual(b)
  })

  it('valores constantes ⇒ intervalo degenerado en la media', () => {
    const ci = bootstrapMeanCi(Array.from({ length: 120 }, () => 0.5), { rng: mulberry32(1), resamples: 2000 })
    expect(ci).toEqual([0.5, 0.5])
  })

  it('el intervalo contiene a la media muestral y está ordenado', () => {
    const values = [2, -1, 1, 3, -2, 0.5, 1.5, -0.5]
    const [lo, hi] = bootstrapMeanCi(values, { rng: mulberry32(3), resamples: 2000 })
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    expect(lo).toBeLessThanOrEqual(mean)
    expect(hi).toBeGreaterThanOrEqual(mean)
    expect(lo).toBeLessThan(hi)
  })

  it('sin valores ⇒ [0, 0]', () => {
    expect(bootstrapMeanCi([], { rng: mulberry32(1), resamples: 2000 })).toEqual([0, 0])
  })
})
