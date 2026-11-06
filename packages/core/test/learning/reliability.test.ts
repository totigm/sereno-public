import { describe, expect, it } from 'vitest'
import { applyReliability, averageRanks, reliability, reliabilityDetail, spearman } from '../../src/learning/reliability'
import { initialLearningState } from '../../src/learning/state'
import { LEARNING, signal, T0 } from './fixtures'

describe('averageRanks', () => {
  it('asigna rangos promedio a los empates', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4])
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2])
    expect(averageRanks([3, 1, 2])).toEqual([3, 1, 2])
  })
})

describe('spearman', () => {
  it('vale 1 con orden idéntico y −1 con orden inverso', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10)
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10)
  })

  it('usa rangos promedio con empates', () => {
    // Rangos x: [1, 2.5, 2.5, 4]; rangos y: [1, 2, 3, 4] ⇒ Pearson entre rangos.
    expect(spearman([10, 20, 20, 30], [1, 2, 3, 4])).toBeCloseTo(0.9486832980505138, 10)
  })

  it('devuelve null sin varianza o con menos de 2 pares', () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull()
    expect(spearman([1], [1])).toBeNull()
  })
})

describe('reliability', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    signals: [signal('momentum', i / 11), signal('funding', -i / 11), signal('bands', i < 6 ? 0.3 : null)],
    forwardReturn4h: i * 0.001,
  }))

  it('calcula Spearman por señal entre su valor y el retorno a 4h', () => {
    const rho = reliability(rows)
    expect(rho.momentum).toBeCloseTo(1, 10)
    expect(rho.funding).toBeCloseTo(-1, 10)
  })

  it('con menos de 10 pares o sin varianza la fiabilidad es 0 (sin dato)', () => {
    const rho = reliability(rows)
    expect(rho.bands).toBe(0)
    expect(rho.trend15m).toBe(0)
    const detail = reliabilityDetail(rows)
    expect(detail.bands).toEqual({ rho: null, n: 6 })
    expect(detail.momentum.n).toBe(12)
  })

  it('ignora filas sin retorno', () => {
    const withGaps = [...rows, { signals: [signal('momentum', 1)], forwardReturn4h: null }]
    expect(reliabilityDetail(withGaps).momentum.n).toBe(12)
  })
})

describe('applyReliability', () => {
  it('w += 0.5·ρ sujeto al tope semanal, sólo en los pesos globales', () => {
    const base = initialLearningState(T0)
    const rho = { ...reliability([]), momentum: 0.1, funding: -0.6, vwap: 0 }
    const { state, log } = applyReliability(base, rho, LEARNING, T0, { sampleSize: 240 })
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.05, 10)
    expect(state.weightsGlobal.funding).toBeCloseTo(0.85, 10) // −0,3 pedido, tope −0,15
    expect(state.weightsGlobal.vwap).toBe(1)
    expect(state.weeklyDelta.funding).toBeCloseTo(-0.15, 10)
    expect(state.weightsBySymbol).toEqual({})
    expect(log.map((c) => c.signal)).toEqual(['momentum', 'funding'])
    expect(log[0]?.kind).toBe('weight_reliability')
    expect(log[0]?.sampleSize).toBe(240)
  })

  it('congelado (en el estado o en los settings) no cambia nada', () => {
    const rho = { ...reliability([]), momentum: 0.5 }
    const frozen = { ...initialLearningState(T0), frozen: true }
    const a = applyReliability(frozen, rho, LEARNING, T0, { sampleSize: 240 })
    expect(a.state).toBe(frozen)
    expect(a.log).toEqual([])
    const base = initialLearningState(T0)
    const b = applyReliability(base, rho, { ...LEARNING, frozen: true }, T0, { sampleSize: 240 })
    expect(b.state).toBe(base)
    expect(b.log).toEqual([])
  })

  it('usa el tope semanal de los settings', () => {
    const rho = { ...reliability([]), momentum: 0.5 }
    const { state } = applyReliability(initialLearningState(T0), rho, { ...LEARNING, weeklyCap: 0.05 }, T0, { sampleSize: 240 })
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.05, 10)
  })
})
