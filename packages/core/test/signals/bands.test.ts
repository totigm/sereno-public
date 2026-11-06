import { describe, expect, it } from 'vitest'
import { bands } from '../../src/signals/bands'
import { run, viewOf } from './fixtures'

// Cierres alternando 99/101: media 100, desvío 1, bandas 98–102.
const alternating = (i: number): number => (i % 2 === 0 ? 99 : 101)

describe('bands', () => {
  it('cerca de la banda superior resta al long (posición invertida y a la mitad)', () => {
    // 20 velas: la última (i = 19) cierra en 101 ⇒ %B = 0,75 ⇒ posición +0,5 ⇒ valor −0,25.
    const r = bands(viewOf({ c15m: run('15m', 20, alternating) }))
    expect(r.id).toBe('bands')
    expect(r.value).toBeCloseTo(-0.25, 12)
    expect(r.detail?.pctB).toBeCloseTo(0.75, 12)
  })

  it('cerca de la banda inferior suma al long', () => {
    // 21 velas: la última (i = 20) cierra en 99 ⇒ %B = 0,25 ⇒ valor +0,25.
    expect(bands(viewOf({ c15m: run('15m', 21, alternating) })).value).toBeCloseTo(0.25, 12)
  })

  it('se recorta a ±0,5 fuera de las bandas', () => {
    const spike = run('15m', 21, (i) => (i === 20 ? 150 : alternating(i)))
    expect(bands(viewOf({ c15m: spike })).value).toBe(-0.5)
    const crash = run('15m', 21, (i) => (i === 20 ? 50 : alternating(i)))
    expect(bands(viewOf({ c15m: crash })).value).toBe(0.5)
  })

  it('null con banda de ancho cero o sin historia', () => {
    expect(bands(viewOf({ c15m: run('15m', 30, () => 100) })).value).toBeNull()
    expect(bands(viewOf({ c15m: run('15m', 19, alternating) })).value).toBeNull()
    expect(bands(viewOf()).value).toBeNull()
  })
})
