import { DEFAULT_SETTINGS } from '@sereno/shared'
import { SIGNAL_IDS, type ClosedPosition, type LearningState, type SignalId } from '../types'
import {
  applyGlobalDelta,
  bump,
  clampWeight,
  formatR,
  isLearningFrozen,
  rollWeek,
  tradeResult,
  type LearningChange,
  type LearningSettings,
} from './state'

// Pesos de señales aprendidos de trades cerrados (spec §8.1) y peso efectivo por
// moneda con encogimiento hacia el global.

interface WeightDelta {
  signal: SignalId
  global: { before: number; after: number }
  symbol: { before: number; after: number }
}

// Sólo pesos y `closedTrades`: la `n` por moneda del encogimiento la lleva
// `updateConfidence`, así que las dos van juntas (ver `learnFromClosedTrade`).
export function updateWeightsFromTrade(
  state: LearningState,
  closed: ClosedPosition,
  learning: LearningSettings,
  now: number,
): { state: LearningState; log: LearningChange[] } {
  // La sombra decide con pesos congelados: un trade suyo nunca enseña.
  if (closed.shadow) return { state, log: [] }
  const closedTrades = state.closedTrades + 1
  let next: LearningState = { ...rollWeek(state, now), closedTrades }
  // Mientras se juntan datos (o congelado) el trade cuenta pero no enseña.
  if (isLearningFrozen(next, learning) || closedTrades < learning.weightLearningMinTrades) {
    return { state: bump(next), log: [] }
  }

  const direction = closed.side === 'long' ? 1 : -1
  const r = tradeResult(closed)
  const symbolWeights = { ...(next.weightsBySymbol[closed.symbol] ?? {}) }
  const deltas: WeightDelta[] = []

  for (const s of closed.signalsAtOpen) {
    if (s.value === null) continue
    const delta = learning.eta * s.value * direction * r
    if (delta === 0) continue
    const g = applyGlobalDelta(next, s.id, delta, learning.weeklyCap)
    next = g.state
    // El peso por moneda nace del global vigente (antes de este ajuste) y desde
    // ahí se separa sólo con los trades de la moneda. El tope semanal se lleva
    // sólo para el global (`weeklyDelta`); el de moneda queda acotado por el rango
    // y, en el peso efectivo, por el encogimiento hacia el global.
    const before = symbolWeights[s.id] ?? g.before
    const after = clampWeight(before + delta)
    symbolWeights[s.id] = after
    if (g.before !== g.after || before !== after) {
      deltas.push({ signal: s.id, global: { before: g.before, after: g.after }, symbol: { before, after } })
    }
  }

  next = bump(next, { weightsBySymbol: { ...next.weightsBySymbol, [closed.symbol]: symbolWeights } })
  if (deltas.length === 0) return { state: next, log: [] }

  const change: LearningChange = {
    at: now,
    kind: 'weight_trade',
    symbol: closed.symbol,
    signal: null,
    message: describeTrade(closed, deltas, closedTrades),
    sampleSize: closedTrades,
    before: Object.fromEntries(deltas.map((d) => [d.signal, { global: d.global.before, symbol: d.symbol.before }])),
    after: Object.fromEntries(deltas.map((d) => [d.signal, { global: d.global.after, symbol: d.symbol.after }])),
  }
  return { state: next, log: [change] }
}

function describeTrade(closed: ClosedPosition, deltas: WeightDelta[], n: number): string {
  const up = deltas.filter((d) => d.global.after > d.global.before).map((d) => d.signal)
  const down = deltas.filter((d) => d.global.after < d.global.before).map((d) => d.signal)
  const parts: string[] = []
  if (up.length > 0) parts.push(`subí ${up.join(', ')}`)
  if (down.length > 0) parts.push(`bajé ${down.join(', ')}`)
  // "long" y "short" son el vocabulario de toda la UI ("Abrí un long 5x en SOL").
  return `Trade ${n} en ${closed.symbol} (${closed.side}, ${formatR(closed.rMultiple)}): ${parts.join('; ')} (n = ${n}).`
}

// Peso efectivo por moneda: (1 − λ)·global + λ·moneda, λ = n / (n + K). Sin
// peso propio para una señal, vale el global.
export function effectiveWeights(
  state: LearningState,
  symbol: string,
  shrinkageK: number = DEFAULT_SETTINGS.learning.shrinkageK,
): Record<SignalId, number> {
  const n = state.tradesBySymbol[symbol] ?? 0
  const lambda = n / (n + shrinkageK)
  const own = state.weightsBySymbol[symbol] ?? {}
  const out = {} as Record<SignalId, number>
  for (const id of SIGNAL_IDS) {
    const global = state.weightsGlobal[id]
    const local = own[id]
    out[id] = local === undefined ? global : (1 - lambda) * global + lambda * local
  }
  return out
}
