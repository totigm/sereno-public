// API pública de @sereno/core, por módulo. Sólo reexporta: importarlo no ejecuta nada.
// Lo que queda afuera a propósito (piezas internas del motor, del simulador y del replay,
// y ayudantes con nombres que chocan) está listado con su motivo en
// `test/barrel-internals.ts`; el test del barrel falla si algo nuevo queda sin decidir.

// Tipos compartidos
export * from './types'

// Indicadores
export * from './indicators'

// Mercado
export * from './market/btc-context'
export * from './market/candle-series'
export * from './market/market-view'
export * from './market/search'

// Universo (`select-universe` reexporta además el DAY_MS local de contract-filter)
export { rejectContract, selectUniverse, STABLECOINS } from './universe/select-universe'
export type {
  ContractFilterOptions,
  ContractFilterReason,
  SelectUniverseInput,
  SelectUniverseResult,
  UniverseExclusionReason,
} from './universe/select-universe'

// Señales
export * from './signals'

// Riesgo
export * from './risk/account-rules'
export * from './risk/costs'
export * from './risk/epsilon'
export * from './risk/liquidation'
export * from './risk/loss-floor'
export * from './risk/sizing'

// Capital y cuenta
export * from './capital/account'

// Exchange
export type * from './exchange/types'
export * from './exchange/errors'
export * from './exchange/fills'
export * from './exchange/paper-exchange'
export * from './exchange/sides'

// Motor
export type * from './engine/types'
export * from './engine/account-guard'
export * from './engine/engine'

// Replay
export type * from './replay/types'
export * from './replay/replay-runner'
export * from './replay/param-tuning'
export * from './replay/scoring'
export * from './replay/weekly-reliability'
export { ReplayMarket } from './replay/market'
export { compactReplayData, compactSymbol, firstViewBySymbol, type CompactSymbol, type PackedSymbolCandles } from './replay/compact'

// Aprendizaje
export {
  initialLearningState,
  isLearningFrozen,
  PENALTY_RETURN_CONFIDENCE,
  signalRecord,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from './learning/state'
export type { LearningChange, LearningChangeKind, LearningSettings } from './learning/state'
export * from './learning/closed-trade'
export * from './learning/confidence'
export * from './learning/params'
export * from './learning/reliability'
export * from './learning/weights'
// El EquityPoint de la sombra es el mismo tipo que el de stats: se publica uno solo.
export { compareShadow, SHADOW_MIN_TRADES, SHADOW_WARN_PP } from './learning/shadow'
export type { PortfolioTrack, ShadowComparison } from './learning/shadow'

// Estadísticas y veredicto
export * from './stats/bootstrap'
export * from './stats/stats'
export * from './stats/verdict'

// Frases del diario (`journal/phrases` es su entrada única)
export * from './journal/phrases'
export { coinName } from './journal/coin-name'
export { SHOWN_THRESHOLD } from './journal/headline'
