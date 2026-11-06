import { describe, expect, it } from 'vitest'
import { initialLearningState } from '../../src/learning/state'
import { effectiveWeights, updateWeightsFromTrade } from '../../src/learning/weights'
import type { LearningState } from '../../src/types'
import { LEARNING, T0, makeClosed, signal } from './fixtures'

const winner = makeClosed({ rMultiple: 2, signals: [signal('momentum', 0.8), signal('funding', -0.5), signal('openInterest', null)] })

function learnN(state: LearningState, n: number, now = T0): LearningState {
  let s = state
  for (let i = 0; i < n; i++) s = updateWeightsFromTrade(s, winner, LEARNING, now).state
  return s
}

describe('updateWeightsFromTrade', () => {
  it('49 trades no cambian los pesos; el 50º sí', () => {
    const after49 = learnN(initialLearningState(T0), 49)
    expect(after49.closedTrades).toBe(49)
    expect(after49.weightsGlobal.momentum).toBe(1)
    expect(after49.weightsBySymbol).toEqual({})

    const r50 = updateWeightsFromTrade(after49, winner, LEARNING, T0)
    expect(r50.state.closedTrades).toBe(50)
    expect(r50.state.weightsGlobal.momentum).not.toBe(1)
    expect(r50.log).toHaveLength(1)
    expect(r50.log[0]?.kind).toBe('weight_trade')
    expect(r50.log[0]?.sampleSize).toBe(50)
  })

  it('una señal que votó +0,8 en un trade long de +2R sube 0.02 × 0.8 × 1 = 0.016', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const { state } = updateWeightsFromTrade(ready, winner, LEARNING, T0)
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.016, 10)
    expect(state.weightsBySymbol.SOLUSDT?.momentum).toBeCloseTo(1.016, 10)
    // Votó en contra (−0,5) de un trade ganador: baja 0.02 × 0.5 = 0.01.
    expect(state.weightsGlobal.funding).toBeCloseTo(0.99, 10)
    // Sin dato: no se toca.
    expect(state.weightsGlobal.openInterest).toBe(1)
    expect(state.weightsBySymbol.SOLUSDT?.openInterest).toBeUndefined()
    expect(state.weeklyDelta.momentum).toBeCloseTo(0.016, 10)
  })

  it('la dirección invierte el voto: en un short ganador, una señal negativa sube', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const short = makeClosed({ side: 'short', rMultiple: 1, signals: [signal('trend15m', -1)] })
    const { state } = updateWeightsFromTrade(ready, short, LEARNING, T0)
    expect(state.weightsGlobal.trend15m).toBeCloseTo(1.01, 10)
  })

  it('el R se recorta a ±2 antes de normalizar', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const huge = makeClosed({ rMultiple: 7, signals: [signal('breakout', 1)] })
    const { state } = updateWeightsFromTrade(ready, huge, LEARNING, T0)
    expect(state.weightsGlobal.breakout).toBeCloseTo(1.02, 10)
  })

  it('10 trades iguales no pasan el tope semanal de 0,15', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const state = learnN(ready, 10)
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.15, 10)
    expect(state.weeklyDelta.momentum).toBeCloseTo(0.15, 10)
  })

  it('al cambiar la semana el tope se libera', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const capped = learnN(ready, 10)
    const { state } = updateWeightsFromTrade(capped, winner, LEARNING, T0 + 7 * 86_400_000)
    expect(state.weightsGlobal.momentum).toBeCloseTo(1.166, 10)
    expect(state.weeklyDelta.momentum).toBeCloseTo(0.016, 10)
  })

  it('congelado: cuenta el trade pero no cambia pesos', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const frozenState = updateWeightsFromTrade({ ...ready, frozen: true }, winner, LEARNING, T0)
    expect(frozenState.state.closedTrades).toBe(50)
    expect(frozenState.state.weightsGlobal.momentum).toBe(1)
    expect(frozenState.log).toEqual([])
    const frozenSettings = updateWeightsFromTrade(ready, winner, { ...LEARNING, frozen: true }, T0)
    expect(frozenSettings.state.weightsGlobal.momentum).toBe(1)
  })

  it('un trade de la cartera sombra no enseña ni cuenta (la sombra va con pesos congelados)', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const shadow = makeClosed({ rMultiple: 2, shadow: true, signals: [signal('momentum', 0.8)] })
    const r = updateWeightsFromTrade(ready, shadow, LEARNING, T0)
    expect(r.state).toBe(ready)
    expect(r.log).toEqual([])
  })

  it('el diario nombra el lado en castellano', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const long = updateWeightsFromTrade(ready, winner, LEARNING, T0)
    expect(long.log[0]?.message).toBe('Trade 50 en SOLUSDT (long, +2,00R): subí momentum; bajé funding (n = 50).')
    const short = makeClosed({ side: 'short', rMultiple: -1, signals: [signal('trend15m', -1)] })
    expect(updateWeightsFromTrade(ready, short, LEARNING, T0).log[0]?.message).toBe(
      'Trade 50 en SOLUSDT (short, −1,00R): bajé trend15m (n = 50).',
    )
  })

  it('no muta el estado de entrada', () => {
    const ready = { ...initialLearningState(T0), closedTrades: 49 }
    const snapshot = structuredClone(ready)
    updateWeightsFromTrade(ready, winner, LEARNING, T0)
    expect(ready).toEqual(snapshot)
  })
})

describe('effectiveWeights', () => {
  it('con n = 30 trades en la moneda pesa mitad global, mitad moneda', () => {
    const base = initialLearningState(T0)
    const state: LearningState = {
      ...base,
      weightsGlobal: { ...base.weightsGlobal, momentum: 1.2 },
      weightsBySymbol: { SOLUSDT: { momentum: 0.8 } },
      tradesBySymbol: { SOLUSDT: 30 },
    }
    const w = effectiveWeights(state, 'SOLUSDT')
    expect(w.momentum).toBeCloseTo(1.0, 10)
    // Señal sin peso por moneda: vale el global.
    expect(w.trend15m).toBe(1)
  })

  it('sin trades en la moneda devuelve los globales', () => {
    const base = initialLearningState(T0)
    const state: LearningState = { ...base, weightsGlobal: { ...base.weightsGlobal, vwap: 1.5 }, weightsBySymbol: { BTCUSDT: { vwap: 0.5 } } }
    expect(effectiveWeights(state, 'BTCUSDT').vwap).toBe(1.5)
    expect(effectiveWeights(state, 'ETHUSDT').vwap).toBe(1.5)
  })
})
