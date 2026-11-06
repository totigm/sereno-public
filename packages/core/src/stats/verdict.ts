import { formatSigned } from '@sereno/shared'
import type { ClosedPosition } from '../types'
import { bootstrapMeanCi } from './bootstrap'
import { assertSingleBook, expectancyR, profitFactor } from './stats'

// Veredicto estadístico (spec §11.6): con muestra suficiente hay "ventaja positiva"
// si la expectativa en R es > 0 con 95% de confianza (bootstrap de 2.000
// remuestreos), el factor de beneficio es ≥ 1,3, el drawdown máximo ≤ 15% y lo
// aprendido no rinde más de 3 pp por debajo de la sombra. Las frases van tal cual
// a la UI.

export const VERDICT_RESAMPLES = 2000
export const VERDICT_MIN_PROFIT_FACTOR = 1.3
export const VERDICT_MAX_DRAWDOWN = 0.15
export const VERDICT_MAX_SHADOW_GAP_PP = 3

export type VerdictStatus = 'insufficient' | 'edge' | 'no_edge'

export interface VerdictOptions {
  minTrades: number
  minDays: number
  /** Retorno de lo aprendido menos el de la sombra, en puntos porcentuales de I₀ (negativo: la sombra rinde más). Si falta, el criterio no se evalúa. */
  shadowGapPp?: number
  /**
   * Drawdown máximo medido de la sesión como fracción (0,18 = 18%): `computeStats(...).maxDrawdownPct`
   * o el peor caso por vela del replay. Obligatorio y validado: un valor por defecto o un NaN
   * aprobarían en silencio el criterio del 15%.
   */
  maxDrawdownPct: number
  rng: () => number
}

export interface Verdict {
  status: VerdictStatus
  missingTrades?: number
  missingDays?: number
  expectancyR: number
  ci95: [number, number]
  /** `Infinity` si no hubo pérdidas (ver `Stats.profitFactor`). */
  profitFactor: number
  maxDrawdownPct: number
  reason: string
}

export function verdict(closed: ClosedPosition[], days: number, opts: VerdictOptions): Verdict {
  assertSingleBook(closed)
  const { maxDrawdownPct } = opts
  // Es una fracción (0,18 = 18%): un valor mayor a 1 es casi seguro un porcentaje pasado tal cual.
  if (!Number.isFinite(maxDrawdownPct) || maxDrawdownPct < 0 || maxDrawdownPct > 1) {
    throw new RangeError(`maxDrawdownPct debe ser una fracción entre 0 y 1 (recibido ${maxDrawdownPct})`)
  }
  if (opts.shadowGapPp !== undefined && !Number.isFinite(opts.shadowGapPp)) {
    throw new RangeError(`shadowGapPp debe ser finito (recibido ${opts.shadowGapPp})`)
  }
  if (!Number.isFinite(days)) throw new RangeError(`days debe ser finito (recibido ${days})`)
  // Un reloj corrido puede dar días negativos: cuentan como sesión recién empezada.
  const elapsedDays = Math.max(0, days)

  const trades = closed.length
  const expectancy = expectancyR(closed)
  const ci95 = bootstrapMeanCi(
    closed.map((c) => c.rMultiple),
    { rng: opts.rng, resamples: VERDICT_RESAMPLES },
  )
  const figures = { expectancyR: expectancy, ci95, profitFactor: profitFactor(closed), maxDrawdownPct }

  const missingTrades = Math.max(0, opts.minTrades - trades)
  const missingDays = Math.max(0, Math.ceil(opts.minDays - elapsedDays))
  if (missingTrades > 0 || missingDays > 0) {
    return {
      status: 'insufficient',
      missingTrades,
      missingDays,
      ...figures,
      reason: insufficientReason(trades, elapsedDays, missingTrades, missingDays),
    }
  }

  const failures = failedCriteria(figures, opts.shadowGapPp)
  if (failures.length === 0) {
    return {
      status: 'edge',
      ...figures,
      reason: `Con ${operaciones(trades)} en ${dias(elapsedDays)}: ventaja positiva (expectativa ${fmtR(expectancy)}, 95% de confianza).`,
    }
  }
  return {
    status: 'no_edge',
    ...figures,
    reason: `Con ${operaciones(trades)}: sin ventaja demostrada (${failures.join('; ')}).`,
  }
}

function failedCriteria(
  f: { expectancyR: number; ci95: [number, number]; profitFactor: number; maxDrawdownPct: number },
  shadowGapPp: number | undefined,
): string[] {
  const failures: string[] = []
  const [lo, hi] = f.ci95
  if (lo <= 0) {
    failures.push(`expectativa ${fmtR(f.expectancyR)}, intervalo ${hi < 0 ? 'por debajo de 0' : 'que incluye 0'}`)
  }
  if (f.profitFactor < VERDICT_MIN_PROFIT_FACTOR) {
    failures.push(`factor de beneficio ${fmtNum(f.profitFactor, 2)} < ${fmtNum(VERDICT_MIN_PROFIT_FACTOR)}`)
  }
  if (f.maxDrawdownPct > VERDICT_MAX_DRAWDOWN) {
    failures.push(`drawdown máximo ${fmtPct(f.maxDrawdownPct)} > ${fmtPct(VERDICT_MAX_DRAWDOWN)}`)
  }
  if (shadowGapPp !== undefined && shadowGapPp < -VERDICT_MAX_SHADOW_GAP_PP) {
    failures.push(`lo aprendido rinde ${fmtNum(-shadowGapPp, 1)} pp por debajo de la sombra`)
  }
  return failures
}

function insufficientReason(trades: number, days: number, missingTrades: number, missingDays: number): string {
  const sample = missingDays > 0 ? `${operaciones(trades)} en ${dias(days)}` : operaciones(trades)
  // Sola, la cantidad se lee como operaciones ("faltan 77.", spec §11.1); junto a los días
  // se nombra, para que "faltan 77 y 14 días" no deje adivinar 77 de qué.
  const tradesPart = missingDays > 0 ? operaciones(missingTrades) : String(missingTrades)
  const missing = [missingTrades > 0 ? tradesPart : null, missingDays > 0 ? dias(missingDays) : null]
    .filter((part): part is string => part !== null)
    .join(' y ')
  return `Con ${sample} todavía no se puede saber si tiene ventaja; faltan ${missing}.`
}

const operaciones = (n: number): string => `${n} ${n === 1 ? 'operación' : 'operaciones'}`
const dias = (n: number): string => {
  const whole = Math.floor(n)
  return `${whole} ${whole === 1 ? 'día' : 'días'}`
}

// Números con coma decimal y sin ceros de relleno: 1,3 · 1,25 · 18% · 15,3%.
function fmtNum(value: number, maxDecimals = 2): string {
  const fixed = value.toFixed(maxDecimals)
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
  return trimmed.replace('.', ',')
}

const fmtPct = (fraction: number): string => `${fmtNum(fraction * 100, 1)}%`

// Signo sobre el valor ya redondeado y con el menos tipográfico: "+0,50R", "−1,00R", "0,00R".
const fmtR = (r: number): string => `${formatSigned(r, 2)}R`
