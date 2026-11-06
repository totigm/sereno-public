import type { Side } from '../types'
import type { OrderSide } from './types'

// En one-way mode una compra abre long y una venta abre short.
export function positionSideOf(side: OrderSide): Side {
  return side === 'buy' ? 'long' : 'short'
}

export function closingSide(side: Side): OrderSide {
  return side === 'long' ? 'sell' : 'buy'
}

export function direction(side: Side): 1 | -1 {
  return side === 'long' ? 1 : -1
}
