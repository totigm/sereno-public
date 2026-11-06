import type { Settings } from '@sereno/shared'
import type { Account } from '../capital/account'
import type { EngineExchange } from '../exchange/types'
import type { AccountSnapshot, ClosedPosition, CloseReason, Composite, Decision, EngineEvent, LearningState, MarketView, Position, SignalId } from '../types'
import type { GuardState } from './account-guard'

// Contratos del motor de trading (`TradingEngine`).

// Puntaje compuesto de una vista con unos pesos. Por defecto `computeComposite`; el
// ajuste de parámetros lo reemplaza por señales precalculadas (los parámetros no
// cambian las señales, spec §8.3).
export type Scorer = (view: MarketView, weights: Record<SignalId, number>) => Composite

export interface PortfolioDeps {
  exchange: EngineExchange
  account: Account
}

export type PortfolioKind = 'real' | 'shadow'

// `stale_stop`: cancelar un stop viejo que cubrió la posición hasta que el nuevo quedó
// puesto (sólo con órdenes superpuestas).
export type ProtectiveOrder = 'stop' | 'take_profit' | 'stale_stop'

// Algo que el motor no pudo hacer y salteó para seguir con el resto: abrir una moneda
// que el simulador no conoce, cerrar una abierta que todavía no tiene precio, un tick o
// un funding con datos inválidos. Nunca deja nada a medias: en el exchange no cambió
// nada y se reintenta con el próximo ciclo o el próximo precio. El runtime lo registra
// (errores recientes en `bot_status`).
// `protect`: el exchange rechazó el stop o el take profit de una abierta, o no canceló un
// stop viejo. La posición no queda sin cuidar (el respaldo por tick la cierra igual) y
// la orden se reintenta con cada precio; se informa una vez por racha de rechazos, no
// en cada reintento.
export type EngineFailure = { at: number; symbol: string; error: unknown } & (
  | { operation: 'open'; portfolio: PortfolioKind }
  | { operation: 'close'; portfolio: PortfolioKind; reason: CloseReason }
  | { operation: 'protect'; portfolio: PortfolioKind; order: ProtectiveOrder }
  | { operation: 'tick' }
  | { operation: 'funding' }
)

export interface EngineDeps {
  exchange: EngineExchange
  settings: Settings
  learning: LearningState
  account: Account
  clock: () => number
  sink: (e: EngineEvent) => void
  onFailure: (failure: EngineFailure) => void
  // Antepuesto a los ids de posición (no vacío): los ids son deterministas y
  // `positions.id` es clave en toda la base, así que cada sesión (vivo o replay) pasa
  // el suyo; si no, dos replays del mismo período abrirían los mismos ids.
  idPrefix: string
  // La sesión opera plata de verdad: el tope de pérdida de lo real nunca se apaga (con
  // `lossCap` al 100% el piso es 0). Papel y replay no lo pasan.
  realMoney?: boolean
  // Cartera sombra: decide con los parámetros y pesos por defecto sobre su propio exchange y cuenta.
  shadow?: PortfolioDeps
  scorer?: Scorer
}

export interface CycleContext {
  // Monedas cuya vela de 15m no llegó a tiempo: su decisión es `no_candle`.
  missingSymbols: string[]
  degraded: string[]
  // Abiertas cuyo contrato desapareció (`selectUniverse(...).delisted`): se cierran.
  delisted?: string[]
}

export interface CycleResult {
  decisions: Decision[]
  opened: Position[]
  closed: ClosedPosition[]
}

// Una abierta con lo que el motor necesita además de `Position` para cerrarla bien:
// los costos de la entrada (para desglosar los del trade) y el tick del contrato.
export interface OpenPositionState {
  position: Position
  entryCosts: { spread: number; slippage: number }
  tickSize: number
}

export interface PortfolioState {
  positions: OpenPositionState[]
  guard: GuardState
}

// La sombra lleva su propia penitencia en un `LearningState` aparte (sus pesos nunca cambian).
export interface ShadowState extends PortfolioState {
  learning: LearningState
}

// Una abierta restaurada cuya liquidación guardada no era la del `mmr` vigente del
// contrato (Binance lo cambió entre reinicios): quedó con la recalculada. `phrase` es
// como lo lee Toti.
export interface LiquidationRecalculated {
  positionId: string
  symbol: string
  shadow: boolean
  from: number
  to: number
  phrase: string
}

// Lo que informa `restore`, en el orden de las abiertas (lo real y después la sombra).
export interface RestoreReport {
  liquidations: LiquidationRecalculated[]
}

// Lo que el runtime persiste para retomar (`restore`).
export interface EngineState {
  real: PortfolioState
  shadow: ShadowState | null
  // Último "esperé" del diario por moneda (como máximo uno cada 4 horas).
  waitedAt: Record<string, number>
}

export interface EngineSnapshot extends EngineState {
  at: number
  learning: LearningState
  accounts: { real: AccountSnapshot; shadow: AccountSnapshot | null }
}
