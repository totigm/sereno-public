import { describe, expect, it } from 'vitest'
import { learnFromClosedTrade } from '../../src/learning/closed-trade'
import { initialLearningState } from '../../src/learning/state'
import { effectiveWeights } from '../../src/learning/weights'
import type { LearningState } from '../../src/types'
import { LEARNING, T0, makeClosed, signal } from './fixtures'

const sol = makeClosed({ symbol: 'SOLUSDT', rMultiple: 2, signals: [signal('momentum', 0.8)] })
const eth = makeClosed({ symbol: 'ETHUSDT', rMultiple: -1, signals: [signal('momentum', 0.5)] })

describe('learnFromClosedTrade', () => {
  it('cuenta el trade a la vez en el total y en la moneda', () => {
    let state: LearningState = initialLearningState(T0)
    for (let i = 0; i < 5; i++) state = learnFromClosedTrade(state, i % 2 === 0 ? sol : eth, LEARNING, T0).state
    expect(state.closedTrades).toBe(5)
    expect(state.tradesBySymbol).toEqual({ SOLUSDT: 3, ETHUSDT: 2 })
  })

  it('en el trade 50 aprende pesos y confianza en una sola pasada', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const { state, log } = learnFromClosedTrade(ready, sol, LEARNING, T0)
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.016, 10)
    expect(state.confidenceBySymbol.SOLUSDT).toBeCloseTo(0.2, 10)
    expect(state.tradesBySymbol.SOLUSDT).toBe(1)
    expect(log.map((c) => c.kind)).toEqual(['weight_trade', 'confidence'])
  })

  it('el encogimiento ve los trades de la moneda que movieron su peso', () => {
    let state: LearningState = { ...initialLearningState(T0), closedTrades: 49 }
    for (let i = 0; i < 30; i++) state = learnFromClosedTrade(state, sol, LEARNING, T0).state
    // λ = 30 / (30 + 30): mitad global, mitad moneda.
    const global = state.weightsGlobal.momentum
    const local = state.weightsBySymbol.SOLUSDT?.momentum ?? Number.NaN
    expect(effectiveWeights(state, 'SOLUSDT').momentum).toBeCloseTo((global + local) / 2, 10)
  })

  it('un trade de la sombra no toca el estado ni deja log: su penitencia la lleva el motor', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const shadow = makeClosed({ symbol: 'SOLUSDT', rMultiple: -1, shadow: true, signals: [signal('momentum', 0.8)] })
    const { state, log } = learnFromClosedTrade(ready, shadow, LEARNING, T0)
    expect(state).toBe(ready)
    expect(log).toEqual([])
  })
})
