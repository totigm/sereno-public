import { formatNumber } from '@sereno/shared'
import { SIGNAL_IDS, type LearningState, type SignalId, type SignalResult } from '../types'
import {
  applyGlobalDelta,
  bump,
  formatWeight,
  isLearningFrozen,
  rollWeek,
  type LearningChange,
  type LearningSettings,
} from './state'

// Fiabilidad de cada señal (spec §8.1, segunda vía): correlación de Spearman entre
// el valor que votó en cada decisión y el retorno del precio a 4 horas.

export interface DecisionSample {
  signals: SignalResult[]
  forwardReturn4h: number | null
}

// Con menos pares que esto la correlación es ruido: se informa "sin dato".
export const MIN_RELIABILITY_SAMPLE = 10
export const RELIABILITY_STEP = 0.5

// Rangos 1-based con promedio en los empates.
export function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length)
  let start = 0
  while (start < order.length) {
    let end = start
    while (end + 1 < order.length && order[end + 1]!.v === order[start]!.v) end++
    const rank = (start + end) / 2 + 1
    for (let k = start; k <= end; k++) ranks[order[k]!.i] = rank
    start = end + 1
  }
  return ranks
}

// Spearman = Pearson entre rangos. `null` si no hay varianza o menos de 2 pares.
export function spearman(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length)
  if (n < 2) return null
  const rx = averageRanks(x.slice(0, n))
  const ry = averageRanks(y.slice(0, n))
  const mean = (n + 1) / 2
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = rx[i]! - mean
    const dy = ry[i]! - mean
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

export function reliabilityDetail(decisions: DecisionSample[]): Record<SignalId, { rho: number | null; n: number }> {
  const xs = {} as Record<SignalId, number[]>
  const ys = {} as Record<SignalId, number[]>
  for (const id of SIGNAL_IDS) {
    xs[id] = []
    ys[id] = []
  }
  for (const d of decisions) {
    if (d.forwardReturn4h === null || !Number.isFinite(d.forwardReturn4h)) continue
    for (const s of d.signals) {
      if (s.value === null || !Number.isFinite(s.value)) continue
      xs[s.id].push(s.value)
      ys[s.id].push(d.forwardReturn4h)
    }
  }
  const out = {} as Record<SignalId, { rho: number | null; n: number }>
  for (const id of SIGNAL_IDS) {
    const n = xs[id].length
    out[id] = { rho: n >= MIN_RELIABILITY_SAMPLE ? spearman(xs[id], ys[id]) : null, n }
  }
  return out
}

// Proyección numérica: sin dato ⇒ 0 (no mueve el peso).
export function reliability(decisions: DecisionSample[]): Record<SignalId, number> {
  const detail = reliabilityDetail(decisions)
  const out = {} as Record<SignalId, number>
  for (const id of SIGNAL_IDS) out[id] = detail[id].rho ?? 0
  return out
}

// wᵢ(global) ← clamp(wᵢ + 0,5·ρᵢ), compartiendo el tope semanal con los trades.
// `sampleSize` es la cantidad de decisiones evaluadas, para el diario.
export function applyReliability(
  state: LearningState,
  rho: Record<SignalId, number>,
  learning: LearningSettings,
  now: number,
  { sampleSize }: { sampleSize: number },
): { state: LearningState; log: LearningChange[] } {
  if (isLearningFrozen(state, learning)) return { state, log: [] }

  let next = rollWeek(state, now)
  const log: LearningChange[] = []
  for (const id of SIGNAL_IDS) {
    const r = rho[id]
    if (!Number.isFinite(r) || r === 0) continue
    const applied = applyGlobalDelta(next, id, RELIABILITY_STEP * r, learning.weeklyCap)
    if (applied.after === applied.before) continue
    next = applied.state
    const verb = applied.after > applied.before ? 'Subí' : 'Bajé'
    log.push({
      at: now,
      kind: 'weight_reliability',
      symbol: null,
      signal: id,
      message: `${verb} el peso global de ${id} de ${formatWeight(applied.before)} a ${formatWeight(applied.after)}: fiabilidad ${formatNumber(r, 2)} (n = ${sampleSize}).`,
      sampleSize,
      before: { global: applied.before, rho: r },
      after: { global: applied.after, rho: r },
    })
  }
  // Si sólo cambió la semana (o nada), igual se devuelve el estado tal cual rodó.
  return { state: next === state ? state : bump(next), log }
}
