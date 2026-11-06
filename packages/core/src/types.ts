// Contratos del motor de decisión (`@sereno/core`). Es el contrato para todas las
// tareas de core: se extiende sólo agregando campos opcionales.
// El motor es puro: sin IO ni reloj; el tiempo entra como parámetro (`t`).

export type Side = 'long' | 'short'
export type Timeframe = '15m' | '1h' | '4h' | '1d'
export type PriceType = 'last' | 'mark'
export interface Candle { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number; closed: boolean }
export interface SymbolInfo { symbol: string; baseAsset: string; minNotional: number; minQty: number; stepSize: number; tickSize: number; quantityPrecision: number; mmr: number; liquidationFee: number; fundingIntervalHours: number; halfSpreadRate: number; underlyingType: string; underlyingSubType: string[]; onboardDate: number }
// Metadatos de un contrato, normalizados a partir de `exchangeInfo` (sus filtros vienen como array de {filterType,…} con strings; el cliente de Binance los mapea a esta forma plana). Los usan el universo y el cliente de Binance.
export interface ContractMeta { symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string; underlyingType: string; underlyingSubType: string[]; onboardDate: number; filters: { minNotional: number; minQty: number; stepSize: number; tickSize: number; quantityPrecision: number; liquidationFee: number } }
export interface FuturesSnapshot { at: number; fundingRate: number | null; nextFundingTime: number | null; openInterest: number | null; openInterest1hAgo: number | null; openInterest4hAgo: number | null; longShortRatio: number | null; takerRatio: number | null }
export interface BtcContext { candles4h: Candle[]; realizedVol24h: number | null; realizedVol30dMean: number | null }
export interface MarketView { t: number; symbol: string; info: SymbolInfo; candles: Record<'15m' | '1h' | '4h', Candle[]>; futures: FuturesSnapshot | null; btc: BtcContext; markPrice: number; lastPrice: number }
export type SignalId = 'trend15m' | 'trendHigher' | 'momentum' | 'breakout' | 'bands' | 'vwap' | 'funding' | 'openInterest' | 'positioning' | 'btcRegime'
// Las diez señales, en el orden canónico de `SignalId` (spec §5.3).
export const SIGNAL_IDS = ['trend15m', 'trendHigher', 'momentum', 'breakout', 'bands', 'vwap', 'funding', 'openInterest', 'positioning', 'btcRegime'] as const satisfies readonly SignalId[]
// Verificación en tiempo de tipos: si se agrega un `SignalId` que no está en `SIGNAL_IDS`, esto no compila.
type AssertTrue<T extends true> = T
type _SignalIdsCompletos = AssertTrue<Exclude<SignalId, (typeof SIGNAL_IDS)[number]> extends never ? true : false>
export interface SignalResult { id: SignalId; value: number | null; detail?: Record<string, number> }
export interface Composite { S: number; Sprime: number; confidence: number; signals: SignalResult[]; missing: SignalId[]; weights: Record<SignalId, number>; modifiers: { adx: number; vol: number }; relVolume: number; higherTrendAgainst: 0 | 1 | 2 }
export type BlockReason = 'higher_trend_against' | 'low_volume' | 'has_position' | 'cooldown' | 'global_cooldown' | 'penalty' | 'degraded' | 'max_positions' | 'max_same_direction' | 'max_margin' | 'max_notional' | 'insufficient_capital' | 'daily_loss' | 'drawdown_pause' | 'streak_pause' | 'paused' | 'below_min_notional' | 'stop_too_small_for_cost' | 'liquidation_too_close' | 'risk_rounding' | 'direction_not_allowed' | 'no_candle' | 'loss_floor' | 'opening_disabled' | 'foreign_position' | 'exchange_rejected'
export interface EntryPlan { side: Side; price: number; distanciaStop: number; riesgoUsd: number; riesgoReal: number; leverage: number; margin: number; notional: number; qty: number; stopPrice: number; takeProfitPrice: number | null; liquidationPrice: number; multipliers: { confidence: number; symbol: number; btc: number }; theta: number }
export type DecisionAction = { kind: 'enter'; plan: EntryPlan } | { kind: 'wait' } | { kind: 'blocked'; reason: BlockReason; wantedSide: Side | null }
export interface Decision { t: number; symbol: string; composite: Composite; action: DecisionAction; shadow?: { Sprime: number; action: DecisionAction['kind'] } }
export type CloseReason = 'stop' | 'take_profit' | 'trailing_stop' | 'signal_flip' | 'time_exit' | 'liquidation' | 'manual' | 'close_all' | 'shield_reduce' | 'delisted' | 'stop_missed_offline' | 'session_archived' | 'loss_floor' | 'closed_on_exchange' | 'unprotected'
export interface Position { id: string; symbol: string; side: Side; leverage: number; margin: number; notional: number; qty: number; entryPrice: number; openedAt: number; stopPrice: number; takeProfitPrice: number | null; liquidationPrice: number; distanciaStop: number; riesgoReal: number; thetaAtOpen: number; trailingActive: boolean; bestPrice: number; stopOrderId: string | null; tpOrderId: string | null; feesPaid: number; fundingPaid: number; shadow: boolean; openReason: string; signalsAtOpen: SignalResult[]; mode: 'auto' | 'custom' }
export interface ClosedPosition extends Position { closedAt: number; exitPrice: number; closeReason: CloseReason; pnlGross: number; pnlNet: number; rMultiple: number; costs: { fees: number; spread: number; slippage: number; funding: number } }
// `reported` (sólo presente en true): precio, cantidad y comisión son los que informó el exchange real, no los de la simulación.
export interface Fill { symbol: string; side: 'buy' | 'sell'; price: number; qty: number; fee: number; at: number; spreadCost: number; slippageCost: number; reported?: true }
export interface MarkTick { symbol: string; markPrice: number; lastPrice: number; at: number; fundingRate: number | null; nextFundingTime: number | null }
export interface FundingEvent { symbol: string; at: number; rate: number; markPrice: number }
// `marksIncomplete` (sólo presente en true): a alguna abierta le faltó la marca y su no realizado no está en `unrealized` ni en `equity`.
export interface AccountSnapshot { capitalInicial: number; saldo: number; equity: number; protegido: number; baseBlindaje: number; capitalBase: number; capitalOperable: number; margenEnUso: number; realizado: number; unrealized: number; reinvest: boolean; marksIncomplete?: boolean }
export interface LearningState { weightsGlobal: Record<SignalId, number>; weightsBySymbol: Record<string, Partial<Record<SignalId, number>>>; weeklyDelta: Record<SignalId, number>; weekStart: number; confidenceBySymbol: Record<string, number>; tradesBySymbol: Record<string, number>; penalties: Record<string, number>; params: { theta: number; k: number; tpR: number; trailingR: number; since: number }; frozen: boolean; closedTrades: number; version: number }
export type EngineEvent =
  | { type: 'decisions'; t: number; decisions: Decision[] }
  | { type: 'position_opened'; position: Position; fill: Fill; phrase: string }
  | { type: 'position_closed'; position: ClosedPosition; fill: Fill; phrase: string }
  | { type: 'stop_moved'; positionId: string; from: number; to: number; at: number; phrase: string }
  | { type: 'funding_applied'; positionId: string; amount: number; at: number }
  // `message` es el texto técnico de `learning_log`; `kind`, `symbol` y `signal` completan su fila y `phrase` es la del diario.
  | { type: 'learning_updated'; at: number; message: string; sampleSize: number; before: unknown; after: unknown; kind?: string; symbol?: string | null; signal?: SignalId | null; phrase?: string }
  // `shadow: true`: aviso de la cartera sombra (hoy sólo su drawdown, que no la pausa). No es de Toti: no pausa la sesión ni va al diario.
  | { type: 'account_rule'; at: number; rule: 'daily_loss' | 'drawdown' | 'streak' | 'shield' | 'shield_insufficient' | 'loss_floor'; phrase: string; data?: unknown; shadow?: boolean }
  | { type: 'waited'; t: number; symbol: string; reason: BlockReason; phrase: string }
