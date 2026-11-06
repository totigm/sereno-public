import type { ClosedPosition, LearningState } from '../types'
import { bump, DAY_MS, formatR, isLearningFrozen, type LearningChange, type LearningSettings } from './state'

// Ajuste semanal de parámetros por walk-forward (spec §8.3). Esta función no corre
// la simulación: recibe `runFn(params)` que devuelve los trades de los últimos 60
// días con esos parámetros, y reparte esos trades en ventana de optimización
// (−60…−15 días) y de validación (−15…0) según `openedAt`.

export interface ParamCombo {
  theta: number
  k: number
  tpR: number
  trailingR: number
}

export type CurrentParams = LearningState['params']

// La spec decía 0,3…0,5; el banco de 180 días mostró que lo bajo pierde más y el
// default pasó a 0,55, así que la grilla corre hacia arriba (mismo tamaño).
export const THETA_GRID = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6] as const
export const K_GRID = [1, 1.5, 2] as const
export const TP_R_GRID = [1.5, 2, 3] as const
export const TRAILING_R_GRID = [0.75, 1, 1.5] as const

export const PARAM_GRID: readonly ParamCombo[] = THETA_GRID.flatMap((theta) =>
  K_GRID.flatMap((k) => TP_R_GRID.flatMap((tpR) => TRAILING_R_GRID.map((trailingR) => ({ theta, k, tpR, trailingR })))),
)

// Umbrales de las condiciones (a)–(d). La ventana de 60 días no está acá: la
// decide `runFn`, que es quien elige qué trades simular.
export interface WalkForwardCriteria {
  minTrades: number
  minImprovementR: number
  seMultiple: number
  minTenureDays: number
  validationDays: number
}

export const WALK_FORWARD_DEFAULTS: Readonly<WalkForwardCriteria> = {
  minTrades: 60,
  minImprovementR: 0.1,
  seMultiple: 2,
  minTenureDays: 7,
  validationDays: 15,
}

export type RejectReason =
  | 'too_few_trades'
  | 'not_best'
  | 'not_significant'
  | 'improvement_too_small'
  | 'worse_in_validation'
  | 'current_too_recent'

export interface ParamStats {
  params: ParamCombo
  expectancyR: number
  se: number
  trades: number
  validationExpectancyR: number
  validationTrades: number
}

export interface RejectedParams {
  params: ParamCombo
  expectancyR: number
  trades: number
  deltaR: number
  reason: RejectReason
}

export interface WalkForwardInput extends Partial<WalkForwardCriteria> {
  runFn: (params: ParamCombo) => { trades: ClosedPosition[] }
  current: CurrentParams
  now: number
  grid?: readonly ParamCombo[]
}

export interface WalkForwardResult {
  adopt: boolean
  best: ParamStats | null
  current: ParamStats
  // Sólo candidatas: la vigente nunca figura como rechazada.
  rejected: RejectedParams[]
  // Los umbrales con que se decidió, para que el diario cite los mismos números.
  criteria: WalkForwardCriteria
}

export function sameParams(a: ParamCombo, b: ParamCombo): boolean {
  return a.theta === b.theta && a.k === b.k && a.tpR === b.tpR && a.trailingR === b.trailingR
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

// Desvío muestral (n − 1); con menos de 2 datos no hay dispersión que estimar.
function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1))
}

function stats(params: ParamCombo, trades: ClosedPosition[], splitAt: number): ParamStats {
  const opt = trades.filter((t) => t.openedAt < splitAt).map((t) => t.rMultiple)
  const val = trades.filter((t) => t.openedAt >= splitAt).map((t) => t.rMultiple)
  return {
    params,
    expectancyR: mean(opt),
    se: opt.length > 0 ? sampleSd(opt) / Math.sqrt(opt.length) : 0,
    trades: opt.length,
    validationExpectancyR: mean(val),
    validationTrades: val.length,
  }
}

export function walkForward(input: WalkForwardInput): WalkForwardResult {
  const criteria: WalkForwardCriteria = {
    minTrades: input.minTrades ?? WALK_FORWARD_DEFAULTS.minTrades,
    minImprovementR: input.minImprovementR ?? WALK_FORWARD_DEFAULTS.minImprovementR,
    seMultiple: input.seMultiple ?? WALK_FORWARD_DEFAULTS.seMultiple,
    minTenureDays: input.minTenureDays ?? WALK_FORWARD_DEFAULTS.minTenureDays,
    validationDays: input.validationDays ?? WALK_FORWARD_DEFAULTS.validationDays,
  }
  const { minTrades, minImprovementR, seMultiple, minTenureDays, validationDays } = criteria
  const grid = input.grid ?? PARAM_GRID
  const splitAt = input.now - validationDays * DAY_MS

  const currentCombo: ParamCombo = {
    theta: input.current.theta,
    k: input.current.k,
    tpR: input.current.tpR,
    trailingR: input.current.trailingR,
  }
  const current = stats(currentCombo, input.runFn(currentCombo).trades, splitAt)

  // Una entrada por candidata, en el orden de la grilla. La vigente es la vara
  // contra la que se compara, no una candidata: se evalúa una sola vez (arriba)
  // aunque esté en la grilla.
  const evaluated: { stats: ParamStats; reason: RejectReason | null }[] = grid
    .filter((params) => !sameParams(params, currentCombo))
    .map((params) => {
      const s = stats(params, input.runFn(params).trades, splitAt)
      return { stats: s, reason: s.trades < minTrades ? 'too_few_trades' : null }
    })

  // Walk-forward clásico: la mejor en optimización es la única que se valida; no
  // se cae a la segunda si falla, porque eso sería elegir mirando la validación.
  let best: ParamStats | null = null
  for (const e of evaluated) {
    if (e.reason === null && (best === null || e.stats.expectancyR > best.expectancyR)) best = e.stats
  }

  const toRejected = (s: ParamStats, reason: RejectReason): RejectedParams => ({
    params: s.params,
    expectancyR: s.expectancyR,
    trades: s.trades,
    deltaR: s.expectancyR - current.expectancyR,
    reason,
  })
  const rejected: RejectedParams[] = []
  for (const e of evaluated) {
    if (e.reason !== null) rejected.push(toRejected(e.stats, e.reason))
    else if (e.stats !== best) rejected.push(toRejected(e.stats, 'not_best'))
  }
  if (best === null) return { adopt: false, best: null, current, rejected, criteria }

  const deltaR = best.expectancyR - current.expectancyR
  // Se exige evidencia contra el mayor de los dos errores estándar: una vigente
  // ruidosa no se reemplaza por una candidata que sólo parece estable.
  const se = Math.max(best.se, current.se)
  const tenureMs = input.now - input.current.since
  const reason: RejectReason | null =
    deltaR <= seMultiple * se
      ? 'not_significant'
      : deltaR < minImprovementR
        ? 'improvement_too_small'
        : best.validationTrades === 0 || best.validationExpectancyR <= current.validationExpectancyR
          ? 'worse_in_validation'
          : tenureMs < minTenureDays * DAY_MS
            ? 'current_too_recent'
            : null

  if (reason !== null) rejected.push(toRejected(best, reason))
  return { adopt: reason === null, best, current, rejected, criteria }
}

export type ParamTuningBlock = 'frozen' | 'tuning_disabled'

// Por qué no se ajustan parámetros esta semana, o `null` si se puede. El job lo
// consulta antes de correr el walk-forward para no simular en vano.
export function paramTuningBlock(state: LearningState, learning: LearningSettings): ParamTuningBlock | null {
  if (isLearningFrozen(state, learning)) return 'frozen'
  if (!learning.paramTuningEnabled) return 'tuning_disabled'
  return null
}

// Lleva el resultado del walk-forward al estado: adopta (con `since = now`) o
// registra el rechazo de la mejor candidata para el diario. Si el aprendizaje
// está congelado o el ajuste apagado no toca nada y lo dice en `skipped`.
export function applyWalkForward(
  state: LearningState,
  result: WalkForwardResult,
  learning: LearningSettings,
  now: number,
): { state: LearningState; log: LearningChange[]; skipped: ParamTuningBlock | null } {
  const skipped = paramTuningBlock(state, learning)
  if (skipped !== null) return { state, log: [], skipped }
  const { best, criteria } = result
  if (result.adopt && best !== null) {
    const params = { ...best.params, since: now }
    return {
      state: bump(state, { params }),
      log: [
        {
          at: now,
          kind: 'params',
          symbol: null,
          signal: null,
          message: `Adopté ${describe(best.params)}: ${formatR(best.expectancyR)} por trade contra ${formatR(result.current.expectancyR)} de la vigente (n = ${best.trades}; validación ${formatR(best.validationExpectancyR)} contra ${formatR(result.current.validationExpectancyR)}).`,
          sampleSize: best.trades,
          before: { ...state.params },
          after: params,
        },
      ],
      skipped: null,
    }
  }
  // Sin mejor candidata es porque ninguna llegó al mínimo de trades: no hay a quién nombrar.
  const top = best === null ? null : rejectedBest(result, best)
  const message =
    top === null
      ? `Ninguna combinación llegó a ${criteria.minTrades} trades en la ventana de optimización; sigo con la vigente.`
      : `Sigo con ${describe(result.current.params)}: la mejor candidata ${describe(top.params)} quedó ${formatR(top.deltaR)} por trade respecto de la vigente y no alcanzó (${reasonText(top.reason, criteria)}).`
  return {
    state,
    log: [
      {
        at: now,
        kind: 'params_rejected',
        symbol: null,
        signal: null,
        message,
        sampleSize: top?.trades ?? 0,
        before: { ...state.params },
        after: { ...state.params },
      },
    ],
    skipped: null,
  }
}

// Un resultado que no adopta tiene a su mejor candidata entre las rechazadas (así lo arma
// `walkForward`); si no está, el resultado es inconsistente y no se lo puede contar.
function rejectedBest(result: WalkForwardResult, best: ParamStats): RejectedParams {
  const found = result.rejected.find((r) => sameParams(r.params, best.params))
  if (!found) throw new Error(`walk-forward inconsistente: la mejor candidata ${describe(best.params)} no adoptó y no figura entre las rechazadas`)
  return found
}

function reasonText(reason: RejectReason, c: WalkForwardCriteria): string {
  switch (reason) {
    case 'too_few_trades':
      return `menos de ${c.minTrades} trades`
    case 'not_best':
      return 'no fue la mejor en optimización'
    case 'not_significant':
      return `la mejora no supera ${plural(c.seMultiple, 'error estándar', 'errores estándar')}`
    case 'improvement_too_small':
      return `la mejora es menor a ${fmt(c.minImprovementR)}R`
    case 'worse_in_validation':
      return 'no gana en la ventana de validación'
    case 'current_too_recent':
      return `la vigente lleva menos de ${plural(c.minTenureDays, 'día', 'días')}`
  }
}

function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`
}

function describe(p: ParamCombo): string {
  return `θ ${fmt(p.theta)} · k ${fmt(p.k)} · TP ${fmt(p.tpR)}R · trailing ${fmt(p.trailingR)}R`
}

// Parámetros tal cual, sin ceros de relleno: "0,35", "1,5", "2".
function fmt(x: number): string {
  return String(x).replace('.', ',')
}
