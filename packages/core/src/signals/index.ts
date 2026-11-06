// Señales, modificadores, filtros y puntaje compuesto (spec §5.3). Cada señal es
// `(view: MarketView) => SignalResult` con valor en [−1, +1] (+ = long) o null sin datos.
export { SIGNALS, evaluateSignals, type Signal } from './registry'
export { trend15m } from './trend-15m'
export { trendHigher, higherTrendScores, type HigherTimeframe } from './trend-higher'
export { momentum, momentumValue, type MomentumInputs } from './momentum'
export { breakout } from './breakout'
export { bands } from './bands'
export { vwap } from './vwap'
export { funding, fundingValue } from './funding'
export { openInterest, openInterestValue } from './open-interest'
export { positioning, positioningValue } from './positioning'
export { btcRegime } from './btc-regime'
export { emaTrend, emaTrendScore, type EmaTrend } from './ema-trend'
export { computeComposite } from './composite'
export {
  ADX_PERIOD,
  REL_VOLUME_WINDOW,
  adxModifier,
  btcVolatilityMultiplier,
  relativeVolume,
  sizingConfidence,
  volumeModifier,
} from './modifiers'
export { DEFAULT_MIN_REL_VOLUME, entryFilters, type EntryContext, type EntryDirection } from './filters'
