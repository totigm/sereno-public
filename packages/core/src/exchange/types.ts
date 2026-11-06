import type { CloseReason, Fill, FundingEvent, MarkTick, Position, Side } from '../types'

// Contrato común del exchange (spec §6): one-way mode, margen aislado, órdenes a
// mercado y condicionales que disparan por precio de marca.

export type OrderId = string
export type OrderSide = 'buy' | 'sell'
export type OrderType = 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'

export interface MarketOrder {
  symbol: string
  side: OrderSide
  qty: number
  reduceOnly?: boolean
}

// Orden condicional que cierra por precio de marca (workingType MARK_PRICE).
// `closePosition: true` cierra toda la posición del símbolo, sin cantidad; con `qty` y
// `reduceOnly` cierra sólo esa cantidad, que es lo que manda el motor: en Binance una
// parte sumada a mano no es del bot y así se pueden tener dos stops un instante.
export type StopOrder = { symbol: string; side: OrderSide; stopPrice: number } & ({ closePosition: true } | { qty: number; reduceOnly: true })

export interface Order {
  id: OrderId
  symbol: string
  type: OrderType
  side: OrderSide
  stopPrice: number
}

export interface Balance {
  // Saldo de la billetera, incluido el margen aislado de las posiciones abiertas.
  total: number
  available: number
  marginInUse: number
  unrealized: number
}

// Lo que el exchange sabe de una posición (como `positionRisk` de Binance). El resto
// de `Position` (señales, R, θ, trailing…) es del motor, que la cruza por símbolo.
export type PositionState = Pick<
  Position,
  'symbol' | 'side' | 'leverage' | 'margin' | 'notional' | 'qty' | 'entryPrice' | 'openedAt' | 'liquidationPrice' | 'feesPaid' | 'fundingPaid'
>

// La posición valorada a la marca vigente.
export type ExchangePosition = PositionState & { markPrice: number; unrealized: number }

// Fill del simulador. `cappedAtBankruptcy`: la salida a `last` pasaba el precio de quiebra
// y se acotó ahí (en margen aislado no se pierde más que el margen). `remainderClosed`: un
// cierre parcial habría dejado un resto bajo `minQty` o `minNotional` y cerró la posición entera.
export interface SimulatedFill extends Fill {
  cappedAtBankruptcy?: true
  remainderClosed?: true
}

export type Unsubscribe = () => void

export interface Exchange {
  // Cómo conviven las órdenes de protección de un símbolo. `single` (o ausente): una por
  // tipo y lado; mover el stop es cancelar el viejo y poner el nuevo. `overlapping`: el
  // viejo y el nuevo pueden estar a la vez; mover es poner el nuevo y recién después
  // cancelar el viejo, así la posición nunca queda sin stop.
  readonly protectiveOrders?: 'single' | 'overlapping'
  placeMarketOrder(req: MarketOrder): Promise<Fill>
  placeStopMarket(req: StopOrder): Promise<OrderId>
  placeTakeProfitMarket(req: StopOrder): Promise<OrderId>
  cancelOrder(symbol: string, orderId: OrderId): Promise<void>
  closePosition(symbol: string, reason: CloseReason): Promise<Fill>
  // Spec §6 escribe `Position[]`, pero un exchange real sólo conoce `ExchangePosition`.
  getPositions(): Promise<ExchangePosition[]>
  getOpenOrders(symbol?: string): Promise<Order[]>
  getBalance(): Promise<Balance>
  setLeverage(symbol: string, leverage: number): Promise<void>
  onMarkPrice(cb: (tick: MarkTick) => void): Unsubscribe
  onFunding(cb: (ev: FundingEvent) => void): Unsubscribe
}

// `closed_on_exchange`: la posición ya no está en el exchange y no se sabe qué la cerró;
// `unprotected`: el exchange no pudo ponerle stop y la cerró a mercado para no dejarla sola;
// `close_all`: la cerró el interruptor (cerrar todo) mientras el motor no estaba.
export type TriggerReason = Extract<CloseReason, 'stop' | 'take_profit' | 'liquidation' | 'closed_on_exchange' | 'unprotected' | 'close_all'>

// Cierre que resolvió el exchange: una orden condicional que disparó, la liquidación o
// (en un exchange real) uno de los de arriba. Trae todo lo que el motor necesita para
// armar la `ClosedPosition`.
export interface TriggeredOrder {
  symbol: string
  reason: TriggerReason
  // `null` en una liquidación: no hay orden, la cierra el exchange.
  orderId: OrderId | null
  // Precio de disparo (stop de la orden o precio de liquidación) y la marca que lo cruzó.
  triggerPrice: number
  markPrice: number
  fill: SimulatedFill
  position: ExchangePosition
  pnlGross: number
  // Variación real del saldo: pnl bruto menos comisión, recortada si el saldo no alcanzó.
  realized: number
  shortfall: number
  // Tasa `liquidationFee` del contrato, sólo informativa y sólo en liquidaciones (spec §6).
  liquidationFeeRate: number | null
}

export interface FundingApplied {
  symbol: string
  side: Side
  qty: number
  rate: number
  markPrice: number
  // Positivo cobra, negativo paga.
  amount: number
  at: number
}

export interface Prices {
  mark: number
  last: number
}

// Lo que informa una restauración. `liquidationRecalculated`: la liquidación guardada no
// era la de la fórmula con el `mmr` vigente del contrato (Binance lo cambió entre
// reinicios) y la posición quedó con la recalculada; `null` si la guardada valía.
export interface RestoreResult {
  liquidationRecalculated: { from: number; to: number } | null
}

// Lo que el motor necesita de un exchange: el contrato común más los métodos con que le
// entrega, de forma síncrona, lo que pasó en el mercado y reconstruye posiciones. El
// simulador (papel, replay y sombra) los resuelve en el momento; un adaptador real
// entrega por acá lo que el exchange le informó desde el tick anterior (fills de stops y
// take profit, liquidaciones, funding), así el motor no sabe con cuál de los dos habla.
export type EngineExchange = Exchange & {
  // Precios del símbolo y los cierres que el exchange ya resolvió.
  processTick(tick: MarkTick): TriggeredOrder[]
  applyFunding(ev: FundingEvent): FundingApplied[]
  setPrices(symbol: string, prices: Prices): void
  restorePosition(state: PositionState): RestoreResult
}

// El simulador implementa la misma forma; el nombre queda para quien lo usa como tal.
export type SimulatedExchange = EngineExchange
