import { describe, expect, it } from 'vitest'
import { perViewScorer } from '../../src/replay/scoring'
import { computeComposite } from '../../src/signals/composite'
import { fullView, unitWeights } from '../signals/fixtures'

// Lo real, la sombra y cada combinación del ajuste puntúan la misma vista con pesos
// distintos: las señales se calculan una vez por vista y se combinan con cada juego.

describe('perViewScorer', () => {
  it('da lo mismo que computeComposite con cada juego de pesos', () => {
    const scorer = perViewScorer()
    const view = fullView()
    const learned = { ...unitWeights, trend15m: 2, bands: 0.5 }
    expect(scorer(view, unitWeights)).toEqual(computeComposite(view, unitWeights))
    expect(scorer(view, learned)).toEqual(computeComposite(view, learned))
  })

  it('calcula las señales de una vista una sola vez, aunque cambien los pesos', () => {
    const scorer = perViewScorer()
    const view = fullView()
    const first = scorer(view, unitWeights)
    const second = scorer(view, { ...unitWeights, momentum: 1.7 })
    expect(second.signals).toBe(first.signals)
    expect(second.S).not.toBe(first.S)
    // Otra vista (aunque sea igual) es otro instante: se calcula de nuevo.
    expect(scorer(fullView(), unitWeights).signals).not.toBe(first.signals)
  })
})
