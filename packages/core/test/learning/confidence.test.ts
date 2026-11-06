import { describe, expect, it } from 'vitest'
import { isPenalized, releaseExpiredPenalties, symbolConfidence, symbolMultiplier, updateConfidence } from '../../src/learning/confidence'
import { initialLearningState } from '../../src/learning/state'
import type { LearningState } from '../../src/types'
import { DAY, LEARNING, T0, makeClosed } from './fixtures'

const loser = makeClosed({ symbol: 'SOLUSDT', rMultiple: -1 })

function runR(state: LearningState, rs: number[], now = T0): LearningState {
  let s = state
  for (const rMultiple of rs) s = updateConfidence(s, makeClosed({ symbol: 'SOLUSDT', rMultiple }), LEARNING, now).state
  return s
}

const loseN = (state: LearningState, n: number, now = T0): LearningState => runR(state, Array<number>(n).fill(-1), now)

describe('updateConfidence', () => {
  it('es una EMA con α = 0,2 del resultado r = clamp(R, −2, 2) / 2', () => {
    const s1 = updateConfidence(initialLearningState(T0), makeClosed({ rMultiple: 1 }), LEARNING, T0)
    expect(s1.state.confidenceBySymbol.SOLUSDT).toBeCloseTo(0.1, 10)
    expect(s1.state.tradesBySymbol.SOLUSDT).toBe(1)
    // +5R se recorta a +2R ⇒ r = 1.
    const s2 = updateConfidence(s1.state, makeClosed({ rMultiple: 5 }), LEARNING, T0)
    expect(s2.state.confidenceBySymbol.SOLUSDT).toBeCloseTo(0.1 + 0.2 * (1 - 0.1), 10)
    expect(s2.log[0]?.kind).toBe('confidence')
  })

  it('7 trades de −1R no alcanzan la penitencia: −0,5·(1 − 0,8⁷) ≈ −0,395 > −0,4', () => {
    const after7 = loseN(initialLearningState(T0), 7)
    expect(after7.confidenceBySymbol.SOLUSDT).toBeCloseTo(-0.5 * (1 - 0.8 ** 7), 10)
    expect(after7.confidenceBySymbol.SOLUSDT).toBeGreaterThan(LEARNING.penaltyThreshold)
    expect(after7.penalties.SOLUSDT).toBeUndefined()
    expect(symbolMultiplier(after7, 'SOLUSDT', T0)).toBeCloseTo(1 - 0.5 * (1 - 0.8 ** 7), 10)
  })

  it('penitencia tras 8 trades de −1R: confianza < −0,4, penalties[symbol] = now + 7d, multiplicador 0,5', () => {
    const after7 = loseN(initialLearningState(T0), 7)
    const r8 = updateConfidence(after7, loser, LEARNING, T0)
    expect(r8.state.confidenceBySymbol.SOLUSDT).toBeCloseTo(-0.5 * (1 - 0.8 ** 8), 10)
    expect(r8.state.confidenceBySymbol.SOLUSDT).toBeLessThan(-0.4)
    expect(r8.state.penalties.SOLUSDT).toBe(T0 + 7 * DAY)
    expect(symbolMultiplier(r8.state, 'SOLUSDT', T0)).toBe(0.5)
    expect(isPenalized(r8.state, 'SOLUSDT', T0)).toBe(true)
    expect(isPenalized(r8.state, 'SOLUSDT', T0 + 7 * DAY)).toBe(false)
    expect(r8.log.map((c) => c.kind)).toEqual(['confidence', 'penalty'])
    expect(r8.log[1]?.sampleSize).toBe(8)
  })

  it('una racha de −2R no penaliza antes de 8 trades, y en el 8º sí', () => {
    const after7 = runR(initialLearningState(T0), [-2, -3, -2, -2, -5, -2, -2])
    // r = −1 en cada trade ⇒ −(1 − 0,8⁷) ≈ −0,79, ya muy por debajo del umbral.
    expect(after7.confidenceBySymbol.SOLUSDT).toBeCloseTo(-(1 - 0.8 ** 7), 10)
    expect(after7.penalties.SOLUSDT).toBeUndefined()
    expect(symbolMultiplier(after7, 'SOLUSDT', T0)).toBe(0.5)

    const r8 = updateConfidence(after7, makeClosed({ symbol: 'SOLUSDT', rMultiple: -2 }), LEARNING, T0)
    expect(r8.state.confidenceBySymbol.SOLUSDT).toBeCloseTo(-(1 - 0.8 ** 8), 10)
    expect(r8.state.penalties.SOLUSDT).toBe(T0 + 7 * DAY)
  })

  it('una racha mixta que termina arriba del umbral no penaliza', () => {
    const state = runR(initialLearningState(T0), [-2, -2, -2, 2, -1, 1, -1, -1])
    expect(state.confidenceBySymbol.SOLUSDT).toBeGreaterThan(-0.4)
    expect(state.penalties.SOLUSDT).toBeUndefined()
  })

  it('una penitencia vigente no se extiende con otro trade perdedor', () => {
    const penalized = loseN(initialLearningState(T0), 8)
    const again = updateConfidence(penalized, loser, LEARNING, T0 + DAY)
    expect(again.state.penalties.SOLUSDT).toBe(T0 + 7 * DAY)
  })

  it('al volver de la penitencia la confianza arranca en −0,2', () => {
    const penalized = loseN(initialLearningState(T0), 8)
    const back = releaseExpiredPenalties(penalized, T0 + 7 * DAY)
    expect(back.state.penalties.SOLUSDT).toBeUndefined()
    expect(back.state.confidenceBySymbol.SOLUSDT).toBe(-0.2)
    expect(symbolMultiplier(back.state, 'SOLUSDT', T0 + 7 * DAY)).toBeCloseTo(0.8, 10)
    expect(back.log[0]?.kind).toBe('penalty_released')
    // Antes de vencer no pasa nada.
    expect(releaseExpiredPenalties(penalized, T0 + 7 * DAY - 1).state).toBe(penalized)
  })

  it('updateConfidence libera por sí misma una penitencia vencida antes de aprender', () => {
    const penalized = loseN(initialLearningState(T0), 8)
    const later = updateConfidence(penalized, makeClosed({ rMultiple: 1 }), LEARNING, T0 + 8 * DAY)
    expect(later.state.penalties.SOLUSDT).toBeUndefined()
    expect(later.state.confidenceBySymbol.SOLUSDT).toBeCloseTo(-0.2 + 0.2 * (0.5 + 0.2), 10)
    expect(later.log.map((c) => c.kind)).toEqual(['penalty_released', 'confidence'])
  })

  it('congelado: cuenta el trade pero no cambia confianza ni penitencias', () => {
    const state = loseN({ ...initialLearningState(T0), frozen: true }, 8)
    expect(state.tradesBySymbol.SOLUSDT).toBe(8)
    expect(state.confidenceBySymbol.SOLUSDT).toBeUndefined()
    expect(state.penalties).toEqual({})

    let viaSettings = initialLearningState(T0)
    for (let i = 0; i < 8; i++) viaSettings = updateConfidence(viaSettings, loser, { ...LEARNING, frozen: true }, T0).state
    expect(viaSettings.confidenceBySymbol.SOLUSDT).toBeUndefined()
    expect(viaSettings.penalties).toEqual({})
  })
})

describe('symbolMultiplier', () => {
  it('sólo reduce: clamp(1 + conf, 0.5, 1)', () => {
    const base = initialLearningState(T0)
    expect(symbolMultiplier(base, 'XRPUSDT', T0)).toBe(1)
    expect(symbolMultiplier({ ...base, confidenceBySymbol: { XRPUSDT: 0.9 } }, 'XRPUSDT', T0)).toBe(1)
    expect(symbolMultiplier({ ...base, confidenceBySymbol: { XRPUSDT: -0.3 } }, 'XRPUSDT', T0)).toBeCloseTo(0.7, 10)
    expect(symbolMultiplier({ ...base, confidenceBySymbol: { XRPUSDT: -0.9 } }, 'XRPUSDT', T0)).toBe(0.5)
  })

  it('con una penitencia vencida pero sin liberar ya usa la confianza de vuelta (−0,2)', () => {
    const penalized = loseN(initialLearningState(T0), 8)
    expect(symbolMultiplier(penalized, 'SOLUSDT', T0 + 7 * DAY - 1)).toBe(0.5)
    expect(symbolMultiplier(penalized, 'SOLUSDT', T0 + 7 * DAY)).toBeCloseTo(0.8, 10)
    expect(symbolConfidence(penalized, 'SOLUSDT', T0 + 7 * DAY)).toBe(-0.2)
  })

  it('queda en [0,5; 1] y la confianza en [−1; 1] con cualquier secuencia de R', () => {
    // Secuencia determinista (LCG) con R entre −6 y +6, más rachas extremas.
    let seed = 7
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    const rs = [...Array.from({ length: 300 }, () => next() * 12 - 6), ...Array<number>(40).fill(-6), ...Array<number>(40).fill(6)]
    let state = initialLearningState(T0)
    let now = T0
    for (const rMultiple of rs) {
      now += 6 * 3_600_000
      state = updateConfidence(state, makeClosed({ symbol: 'SOLUSDT', rMultiple }), LEARNING, now).state
      const conf = symbolConfidence(state, 'SOLUSDT', now)
      const m = symbolMultiplier(state, 'SOLUSDT', now)
      expect(conf).toBeGreaterThanOrEqual(-1)
      expect(conf).toBeLessThanOrEqual(1)
      expect(m).toBeGreaterThanOrEqual(0.5)
      expect(m).toBeLessThanOrEqual(1)
    }
  })
})
