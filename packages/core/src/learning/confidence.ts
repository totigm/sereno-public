import { formatNumber } from '@sereno/shared'
import type { ClosedPosition, LearningState } from '../types'
import {
  bump,
  clamp,
  DAY_MS,
  formatR,
  isLearningFrozen,
  PENALTY_RETURN_CONFIDENCE,
  tradeResult,
  type LearningChange,
  type LearningSettings,
} from './state'

// Confianza por moneda (spec §8.2): EMA del resultado r de cada trade (en [−1, 1]),
// multiplicador de tamaño que sólo reduce, y penitencia cuando una moneda viene
// sangrando.

export const SYMBOL_MULTIPLIER_MIN = 0.5
export const SYMBOL_MULTIPLIER_MAX = 1

export function isPenalized(state: LearningState, symbol: string, now: number): boolean {
  const until = state.penalties[symbol]
  return until !== undefined && until > now
}

function hasExpiredPenalty(state: LearningState, symbol: string, now: number): boolean {
  const until = state.penalties[symbol]
  return until !== undefined && until <= now
}

// Confianza vigente en `now`: si la penitencia ya venció pero todavía nadie la
// liberó (`releaseExpiredPenalties`), vale la de vuelta (−0,2), no la guardada.
export function symbolConfidence(state: LearningState, symbol: string, now: number): number {
  if (hasExpiredPenalty(state, symbol, now)) return PENALTY_RETURN_CONFIDENCE
  return state.confidenceBySymbol[symbol] ?? 0
}

// mMoneda = clamp(1 + confianza, 0,5, 1): nunca agranda el riesgo. En penitencia
// la moneda no abre, pero si alguien pregunta el tamaño es el mínimo.
export function symbolMultiplier(state: LearningState, symbol: string, now: number): number {
  if (isPenalized(state, symbol, now)) return SYMBOL_MULTIPLIER_MIN
  return clamp(1 + symbolConfidence(state, symbol, now), SYMBOL_MULTIPLIER_MIN, SYMBOL_MULTIPLIER_MAX)
}

// Las penitencias vencidas se levantan y la moneda vuelve con confianza −0,2.
export function releaseExpiredPenalties(state: LearningState, now: number): { state: LearningState; log: LearningChange[] } {
  const expired = Object.entries(state.penalties).filter(([, until]) => until <= now)
  if (expired.length === 0) return { state, log: [] }

  const penalties = { ...state.penalties }
  const confidenceBySymbol = { ...state.confidenceBySymbol }
  const log: LearningChange[] = []
  for (const [symbol, until] of expired) {
    delete penalties[symbol]
    const before = confidenceBySymbol[symbol] ?? 0
    confidenceBySymbol[symbol] = PENALTY_RETURN_CONFIDENCE
    log.push({
      at: now,
      kind: 'penalty_released',
      symbol,
      signal: null,
      message: `${symbol} vuelve de la penitencia con confianza ${formatNumber(PENALTY_RETURN_CONFIDENCE, 2)}.`,
      sampleSize: state.tradesBySymbol[symbol] ?? 0,
      before: { confidence: before, penaltyUntil: until },
      after: { confidence: PENALTY_RETURN_CONFIDENCE, penaltyUntil: null },
    })
  }
  return { state: bump(state, { penalties, confidenceBySymbol }), log }
}

// Además de la confianza, lleva `tradesBySymbol`, que es la `n` del encogimiento
// de pesos por moneda: por eso cada trade cerrado tiene que pasar por acá aunque
// el aprendizaje esté congelado (ver `learnFromClosedTrade`).
export function updateConfidence(
  state: LearningState,
  closed: ClosedPosition,
  learning: LearningSettings,
  now: number,
): { state: LearningState; log: LearningChange[] } {
  const released = releaseExpiredPenalties(state, now)
  const log = [...released.log]
  const { symbol } = closed
  const trades = (released.state.tradesBySymbol[symbol] ?? 0) + 1
  const counted = bump(released.state, { tradesBySymbol: { ...released.state.tradesBySymbol, [symbol]: trades } })
  if (isLearningFrozen(counted, learning)) return { state: counted, log }

  const before = counted.confidenceBySymbol[symbol] ?? 0
  const after = before + learning.confidenceAlpha * (tradeResult(closed) - before)
  let next = counted
  if (after !== before) {
    next = { ...next, confidenceBySymbol: { ...next.confidenceBySymbol, [symbol]: after } }
    log.push({
      at: now,
      kind: 'confidence',
      symbol,
      signal: null,
      message: `Confianza en ${symbol}: ${formatNumber(before, 2)} → ${formatNumber(after, 2)} tras ${formatR(closed.rMultiple)} (n = ${trades}).`,
      sampleSize: trades,
      before: { confidence: before },
      after: { confidence: after },
    })
  }

  const shouldPenalize = trades >= learning.penaltyMinTrades && after < learning.penaltyThreshold && !isPenalized(next, symbol, now)
  if (shouldPenalize) {
    const until = now + learning.penaltyDays * DAY_MS
    next = { ...next, penalties: { ...next.penalties, [symbol]: until } }
    log.push({
      at: now,
      kind: 'penalty',
      symbol,
      signal: null,
      message: `${symbol} queda en penitencia ${learning.penaltyDays} días: confianza ${formatNumber(after, 2)} tras ${trades} trades.`,
      sampleSize: trades,
      before: { penaltyUntil: null, confidence: after },
      after: { penaltyUntil: until, confidence: after },
    })
  }
  return { state: next, log }
}
