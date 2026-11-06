// Puntaje compuesto (spec §5.3a y §5.3b).
//   S  = Σ_disp wᵢ·sᵢ / Σ_disp wᵢ   sólo sobre señales con dato (las demás van a `missing`); 0 si no hay ninguna
//   S′ = clamp(S × mADX × mVol, −1, +1)       c = |S|
// `higherTrendAgainst` cuenta cuántos de {1h, 4h} tienen tendencia de signo opuesto a S.
import { adx } from '../indicators/adx'
import type { Composite, MarketView, SignalId, SignalResult } from '../types'
import { ADX_PERIOD, adxModifier, relativeVolume, volumeModifier } from './modifiers'
import { evaluateSignals } from './registry'
import { clamp } from './result'
import { higherTrendScores, type HigherTimeframe } from './trend-higher'

// Un peso no finito o negativo no tiene sentido como ponderación: la señal no pesa (cuenta 0),
// pero tenía dato, así que no se lista como faltante.
const usableWeight = (w: number): number => (Number.isFinite(w) && w > 0 ? w : 0)

function weightedScore(signals: readonly SignalResult[], weights: Record<SignalId, number>): number {
  let numerator = 0
  let denominator = 0
  for (const { id, value } of signals) {
    if (value === null) continue
    const w = usableWeight(weights[id])
    numerator += w * value
    denominator += w
  }
  return denominator > 0 ? numerator / denominator : 0
}

function countAgainst(S: number, higherTrend: Record<HigherTimeframe, number | null>): 0 | 1 | 2 {
  const side = Math.sign(S)
  if (side === 0) return 0
  const against = Object.values(higherTrend).filter((score) => score !== null && Math.sign(score) === -side).length
  return against as 0 | 1 | 2
}

// Lo que el compuesto saca de la vista sin mirar los pesos: las señales, los modificadores
// y la tendencia de cada marco mayor. Es la parte cara; `combineComposite` le suma los
// pesos. Quien puntúa la misma vista con varios juegos de pesos (lo real, la sombra, cada
// combinación del ajuste de parámetros) la calcula una sola vez: los pesos y los
// parámetros no cambian las señales (spec §8.3). Los composites que salen de un mismo
// `CompositeInputs` comparten sus arreglos: nadie los muta.
export interface CompositeInputs {
  signals: SignalResult[]
  missing: SignalId[]
  modifiers: { adx: number; vol: number }
  relVolume: number
  higherTrend: Record<HigherTimeframe, number | null>
}

export function compositeInputs(view: MarketView): CompositeInputs {
  const signals = evaluateSignals(view)
  const candles = view.candles['15m']
  // Sin 96 velas previas el volumen relativo es neutro: no modifica S′ ni dispara `low_volume`.
  const relVolume = relativeVolume(candles) ?? 1
  return {
    signals,
    missing: signals.filter((s) => s.value === null).map((s) => s.id),
    modifiers: { adx: adxModifier(adx(candles, ADX_PERIOD).at(-1) ?? null), vol: volumeModifier(relVolume) },
    relVolume,
    higherTrend: higherTrendScores(view),
  }
}

export function combineComposite(inputs: CompositeInputs, weights: Record<SignalId, number>): Composite {
  const { signals, missing, modifiers, relVolume } = inputs
  const S = weightedScore(signals, weights)
  return {
    S,
    Sprime: clamp(S * modifiers.adx * modifiers.vol, -1, 1),
    confidence: Math.abs(S),
    signals,
    missing,
    weights: { ...weights },
    modifiers: { adx: modifiers.adx, vol: modifiers.vol },
    relVolume,
    higherTrendAgainst: countAgainst(S, inputs.higherTrend),
  }
}

export function computeComposite(view: MarketView, weights: Record<SignalId, number>): Composite {
  return combineComposite(compositeInputs(view), weights)
}
