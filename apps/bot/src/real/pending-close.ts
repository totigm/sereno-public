// Un cierre que resolvió Binance (un stop o take profit que disparó, una liquidación, una
// posición cerrada sin que el bot lo viera) o el adaptador (sin stop posible): espera en la
// cola del adaptador hasta que el motor lo pida con `processTick` o `closePosition`. Los
// números son los de Binance.

import type { Fill } from '@sereno/core'
import { closingSide } from '@sereno/core/src/exchange/sides'
import type { ExchangePosition, TriggeredOrder, TriggerReason } from '@sereno/core/src/exchange/types'
import type { OrderFill } from './order-tracker'

export interface PendingClose {
  reason: TriggerReason
  fill: OrderFill
  // El precio del stop o take profit que disparó, la liquidación o, sin disparo, el del fill.
  triggerPrice: number
  // El id que conoce el motor: el `clientAlgoId` que disparó o la orden `c`; sin él en una
  // liquidación o en un cierre que no hizo el bot.
  orderId?: string
  // El fill ya junta todo lo que redujo la posición desde su apertura (lo armó REST con los
  // trades), incluido lo que el bot haya cerrado a medias: no se le suma nada más.
  wholePosition?: boolean
}

// Lo ya cerrado a mercado de una posición que quedó a medias.
export interface PartialClose {
  fills: OrderFill[]
  // Lo pagado de más contra el último precio al mandar cada parte.
  slippage: number
}

// Un cierre que terminó Binance (el stop sobre el resto de un cierre `c` a medias) con lo que
// el bot ya había cerrado: el fill de la posición entera. Uno armado con todos los trades
// desde la apertura (`wholePosition`) ya lo trae.
export function withPartial(close: PendingClose, partial: PartialClose | undefined): { close: PendingClose; slippageCost: number } {
  if (!partial || close.wholePosition) return { close, slippageCost: 0 }
  return { close: { ...close, fill: aggregateFills([...partial.fills, close.fill]) }, slippageCost: partial.slippage }
}

// El fill como lo ve el motor. Binance no informa spread: lo que se pagó de más contra el
// último precio al mandar la orden va como slippage.
export function engineFill(symbol: string, side: Fill['side'], fill: OrderFill, slippageCost = 0): Fill {
  return { symbol, side, price: fill.avgPrice, qty: fill.qty, fee: fill.commission, at: fill.at, spreadCost: 0, slippageCost, reported: true }
}

// Lo que se pagó de más contra `reference` (el último precio al mandar): nunca negativo.
export function adverseCost(side: Fill['side'], avgPrice: number, reference: number, qty: number): number {
  const direction = side === 'buy' ? 1 : -1
  return Math.max(0, direction * (avgPrice - reference)) * qty
}

// Lo que el cierre movió en la billetera según Binance.
export function realizedOf(fill: OrderFill): number {
  return fill.realizedPnl - fill.commission
}

export function triggeredOrder(position: ExchangePosition, close: PendingClose, markPrice: number, liquidationFeeRate: number, slippageCost = 0): TriggeredOrder {
  const { symbol } = position
  const liquidation = close.reason === 'liquidation'
  return {
    symbol,
    reason: close.reason,
    orderId: liquidation ? null : (close.orderId ?? null),
    triggerPrice: close.triggerPrice,
    markPrice,
    fill: engineFill(symbol, closingSide(position.side), close.fill, slippageCost),
    position,
    pnlGross: close.fill.realizedPnl,
    realized: realizedOf(close.fill),
    shortfall: 0,
    liquidationFeeRate: liquidation ? liquidationFeeRate : null,
  }
}

// Varios fills de cierre como uno: cantidades y comisiones sumadas, precio ponderado.
export function aggregateFills(fills: readonly OrderFill[]): OrderFill {
  const last = fills.at(-1)
  if (!last) throw new RangeError('aggregateFills: sin fills')
  const qty = fills.reduce((sum, f) => sum + f.qty, 0)
  const quote = fills.reduce((sum, f) => sum + f.qty * f.avgPrice, 0)
  return {
    clientOrderId: last.clientOrderId,
    orderId: last.orderId,
    qty,
    avgPrice: qty > 0 ? quote / qty : 0,
    commission: fills.reduce((sum, f) => sum + f.commission, 0),
    realizedPnl: fills.reduce((sum, f) => sum + f.realizedPnl, 0),
    at: Math.max(...fills.map((f) => f.at)),
    status: last.status,
    complete: fills.every((f) => f.complete),
  }
}
