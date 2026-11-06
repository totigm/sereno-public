import type { Side } from '../types'
import { direction } from './sides'
import type { Order } from './types'

// Reglas de disparo por precio de marca, iguales a Binance USDT-M:
// STOP_MARKET sell ⇐ marca ≤ stop, buy ⇐ marca ≥ stop; TAKE_PROFIT_MARKET al revés.
export function orderTriggered(order: Pick<Order, 'type' | 'side' | 'stopPrice'>, mark: number): boolean {
  const below = mark <= order.stopPrice
  const above = mark >= order.stopPrice
  if (order.type === 'STOP_MARKET') return order.side === 'sell' ? below : above
  return order.side === 'sell' ? above : below
}

export function liquidationCrossed(side: Side, mark: number, liquidationPrice: number): boolean {
  return side === 'long' ? mark <= liquidationPrice : mark >= liquidationPrice
}

// Precio de quiebra: donde el pnl de la posición iguala al margen aislado. Una
// liquidación se ejecuta ahí, así que la pérdida bruta es exactamente el margen.
// Sale del margen y no de `entrada × (1 ∓ 1/L)` para que una posición restaurada
// con un margen persistido pierda justo ese margen.
export function bankruptcyPrice(side: Side, entryPrice: number, margin: number, qty: number): number {
  return entryPrice - (direction(side) * margin) / qty
}

// Un precio de salida peor que la quiebra: más abajo para el long, más arriba para el short.
export function pastBankruptcy(side: Side, price: number, bankruptcy: number): boolean {
  return side === 'long' ? price < bankruptcy : price > bankruptcy
}
