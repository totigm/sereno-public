import { DEFAULT_SETTINGS, formatNumber, formatSigned, type Settings } from '@sereno/shared'
import { SIGNAL_IDS, type ClosedPosition, type LearningState, type SignalId } from '../types'

// Estado de aprendizaje de una sesión (spec §8): valores iniciales, calendario
// semanal del tope de cambio y la aritmética acotada que comparten las dos vías
// de aprendizaje de pesos (trades cerrados y fiabilidad).

export type LearningSettings = Settings['learning']

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
export const WEIGHT_MIN = 0.2
export const WEIGHT_MAX = 2
export const PENALTY_RETURN_CONFIDENCE = -0.2

export type LearningChangeKind =
  | 'weight_trade'
  | 'weight_reliability'
  | 'confidence'
  | 'penalty'
  | 'penalty_released'
  | 'params'
  | 'params_rejected'

// Una fila de `learning_log`: lo que cambió, con tamaño muestral y antes/después
// para que el diario pueda explicarlo. `symbol` y `signal` acotan el cambio.
export interface LearningChange {
  at: number
  kind: LearningChangeKind
  symbol: string | null
  signal: SignalId | null
  message: string
  sampleSize: number
  before: unknown
  after: unknown
}

export function signalRecord<T>(value: T): Record<SignalId, T> {
  return Object.fromEntries(SIGNAL_IDS.map((id) => [id, value])) as Record<SignalId, T>
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function clampWeight(w: number): number {
  return clamp(w, WEIGHT_MIN, WEIGHT_MAX)
}

// Resultado normalizado del trade (spec §8.1): R recortado a ±2 y llevado a
// [−1, 1]. Lo usan tanto los pesos como la confianza por moneda.
export function tradeResult(closed: Pick<ClosedPosition, 'rMultiple'>): number {
  return clamp(closed.rMultiple, -2, 2) / 2
}

export function initialLearningState(now: number): LearningState {
  return {
    weightsGlobal: signalRecord(1),
    weightsBySymbol: {},
    weeklyDelta: signalRecord(0),
    weekStart: weekStartOf(now),
    confidenceBySymbol: {},
    tradesBySymbol: {},
    penalties: {},
    params: {
      theta: DEFAULT_SETTINGS.entry.theta,
      k: DEFAULT_SETTINGS.exits.k,
      tpR: DEFAULT_SETTINGS.exits.tpR,
      trailingR: DEFAULT_SETTINGS.exits.trailingR,
      since: now,
    },
    frozen: false,
    closedTrades: 0,
    version: 1,
  }
}

// La semana del tope arranca el lunes 00:00 UTC (el 1/1/1970 fue jueves: el
// primer lunes de la época cae a 4 días).
const FIRST_MONDAY = 4 * DAY_MS
export function weekStartOf(t: number): number {
  return Math.floor((t - FIRST_MONDAY) / WEEK_MS) * WEEK_MS + FIRST_MONDAY
}

// Si cambió la semana, el acumulado semanal vuelve a cero. Devuelve el mismo
// objeto si no hay nada que hacer.
export function rollWeek(state: LearningState, now: number): LearningState {
  const weekStart = weekStartOf(now)
  if (weekStart === state.weekStart) return state
  return { ...state, weekStart, weeklyDelta: signalRecord(0) }
}

export function isLearningFrozen(state: LearningState, learning: LearningSettings): boolean {
  return state.frozen || learning.frozen
}

// Nueva revisión del estado: cada cambio sube `version`.
export function bump(state: LearningState, patch: Partial<LearningState> = {}): LearningState {
  return { ...state, ...patch, version: state.version + 1 }
}

// Mueve un peso global `delta`, respetando el tope semanal acumulado (±cap) y el
// rango [0,2, 2]. Lo que cuenta para el tope es el cambio efectivamente aplicado.
export function applyGlobalDelta(
  state: LearningState,
  id: SignalId,
  delta: number,
  weeklyCap: number,
): { state: LearningState; before: number; after: number } {
  const before = state.weightsGlobal[id]
  const used = state.weeklyDelta[id]
  const allowed = clamp(delta, -weeklyCap - used, weeklyCap - used)
  const after = clampWeight(before + allowed)
  if (after === before) return { state, before, after }
  return {
    state: {
      ...state,
      weightsGlobal: { ...state.weightsGlobal, [id]: after },
      weeklyDelta: { ...state.weeklyDelta, [id]: used + (after - before) },
    },
    before,
    after,
  }
}

export function formatWeight(w: number): string {
  return formatNumber(w, 2)
}

// R con signo para el diario: "+0,50R", "−1,00R".
export function formatR(r: number): string {
  return `${formatSigned(r, 2)}R`
}
