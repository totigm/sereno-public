import type { ClosedPositionRecord } from '@sereno/db'
import { computeStats, type Stats } from '@sereno/core/src/stats/stats'
import { verdict, type VerdictStatus } from '@sereno/core/src/stats/verdict'
import { SHADOW_MIN_TRADES } from '@sereno/core/src/learning/shadow'
import type { DrawdownView } from './sql/equity'

// Estadísticas y veredicto de una sesión (spec §11.1 Posiciones, §11.6). Siempre de un
// solo libro: core tira si se mezclan reales y sombra.

/** Muestra mínima para evaluar el veredicto (spec §11.6). */
export const VERDICT_MIN_TRADES = 100
export const VERDICT_MIN_DAYS = 30

/** `Stats` de core listo para mostrar: sin `Infinity` y con el drawdown medido en la base. */
export type StatsView = Omit<Stats, 'profitFactor'> & {
  /** null si no hubo pérdidas (en core es `Infinity`). */
  profitFactor: number | null
  /** El drawdown con su pico, su piso y la resolución de la curva (`maxDrawdownPct` es su `pct`). */
  maxDrawdown: DrawdownView
}

export interface VerdictView {
  status: VerdictStatus
  /** La línea tal cual para la UI ("Con 23 operaciones todavía no se puede saber…"). */
  reason: string
  missingTrades: number
  missingDays: number
  expectancyR: number
  ci95: [number, number]
  profitFactor: number | null
  maxDrawdownPct: number
  trades: number
  /** Lo aprendido menos la sombra en pp de I₀; null si la sombra todavía no tiene muestra (el criterio no se evalúa). */
  shadowGapPp: number | null
}

export const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? n : null)

export function statsView(real: ClosedPositionRecord[], drawdown: DrawdownView): StatsView {
  // La curva no se pasa: el drawdown ya viene calculado en la base sobre todos sus puntos.
  const stats = computeStats(real, [])
  return { ...stats, profitFactor: finiteOrNull(stats.profitFactor), maxDrawdownPct: drawdown.pct, maxDrawdown: drawdown }
}

export interface VerdictInput {
  real: ClosedPositionRecord[]
  shadowTrades: number
  days: number
  drawdown: DrawdownView
  capitalInicial: number
  /** Equity de lo aprendido y de la sombra al final del período; sin sombra, el criterio no se evalúa. */
  equity: number
  shadowEquity: number | null
  /** Semilla del bootstrap: con la misma, el veredicto no cambia de una carga a otra. */
  seed: string
}

export function verdictView(input: VerdictInput): VerdictView {
  const gap =
    input.shadowEquity !== null && input.shadowTrades >= SHADOW_MIN_TRADES
      ? ((input.equity - input.shadowEquity) / input.capitalInicial) * 100
      : undefined
  const v = verdict(input.real, input.days, {
    minTrades: VERDICT_MIN_TRADES,
    minDays: VERDICT_MIN_DAYS,
    maxDrawdownPct: input.drawdown.pct,
    rng: seededRng(`${input.seed}:${input.real.length}`),
    ...(gap === undefined ? {} : { shadowGapPp: gap }),
  })
  return {
    status: v.status,
    reason: v.reason,
    missingTrades: v.missingTrades ?? 0,
    missingDays: v.missingDays ?? 0,
    expectancyR: v.expectancyR,
    ci95: v.ci95,
    profitFactor: finiteOrNull(v.profitFactor),
    maxDrawdownPct: v.maxDrawdownPct,
    trades: input.real.length,
    shadowGapPp: gap ?? null,
  }
}

// mulberry32 sembrado con FNV-1a: el bootstrap necesita azar, pero el mismo libro
// tiene que dar el mismo intervalo en cada recarga.
export function seededRng(seed: string): () => number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let state = h >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
