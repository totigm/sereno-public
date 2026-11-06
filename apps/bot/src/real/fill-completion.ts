// Un fill que llegó sin todos sus trades (Binance tarda en publicarlos en `userTrades`):
// se vuelve a pedir una vez y, si sigue corto, la comisión y el pnl se estiman en proporción
// a lo que sí se vio (o con la comisión taker si no se vio nada, o si Binance no contesta).
// Nunca se registra una comisión de menos en silencio: quien llama avisa la estimación.

import type { BinanceTradeRest } from '../binance/trade-rest'
import { restFill, type OrderFill } from './order-tracker'

export type TradesApi = Pick<BinanceTradeRest, 'userTrades'>

export interface Completion {
  fill: OrderFill
  // true si la comisión y el pnl son una estimación.
  estimated: boolean
}

export interface Estimate {
  takerFeeRate: number
  // El pnl realizado del fill si no se vio ningún trade (0 al abrir).
  realizedPnl: (fill: OrderFill) => number
}

export async function completeFill(trade: TradesApi, symbol: string, fill: OrderFill, estimate: Estimate): Promise<Completion> {
  if (fill.complete || fill.qty <= 0) return { fill, estimated: false }
  const trades = await trade.userTrades(symbol, { orderId: fill.orderId })
  const ack = { symbol, orderId: fill.orderId, clientOrderId: fill.clientOrderId, status: fill.status, executedQty: fill.qty, avgPrice: fill.avgPrice, updateTime: fill.at }
  const seen = restFill(ack, trades)
  if (seen.complete) return { fill: seen, estimated: false }
  const traded = trades.reduce((sum, t) => sum + t.qty, 0)
  if (traded > 0) {
    const scale = fill.qty / traded
    return { fill: { ...seen, commission: seen.commission * scale, realizedPnl: seen.realizedPnl * scale }, estimated: true }
  }
  return { fill: estimatedFill(fill, estimate), estimated: true }
}

// Sin ningún trade a la vista: una orden a mercado paga la comisión taker sobre lo ejecutado.
export function estimatedFill(fill: OrderFill, estimate: Estimate): OrderFill {
  return { ...fill, commission: fill.qty * fill.avgPrice * estimate.takerFeeRate, realizedPnl: estimate.realizedPnl(fill) }
}
