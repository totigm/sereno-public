// De las respuestas crudas de operación (`trade-types.ts`) a las formas que usa el bot.

import { num } from './numbers'
import type {
  AlgoOrder,
  ApiRestrictions,
  BinancePosition,
  IncomeRow,
  OrderAck,
  RawAlgoOrder,
  RawApiRestrictions,
  RawIncome,
  RawOrder,
  RawPositionRisk,
  RawUserTrade,
  UserTrade,
} from './trade-types'

export function toOrderAck(raw: RawOrder): OrderAck {
  const executedQty = num(raw.executedQty)
  return {
    symbol: raw.symbol,
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    status: raw.status,
    executedQty,
    avgPrice: averagePrice(raw, executedQty),
    updateTime: raw.updateTime,
  }
}

// `avgPrice` si vino y es útil; si no, lo ejecutado en USDT sobre la cantidad.
function averagePrice(raw: RawOrder, executedQty: number): number {
  const avg = raw.avgPrice === undefined ? 0 : num(raw.avgPrice)
  if (avg > 0 || executedQty === 0) return avg
  return raw.cumQuote === undefined ? 0 : num(raw.cumQuote) / executedQty
}

export function toAlgoOrder(raw: RawAlgoOrder): AlgoOrder {
  return {
    symbol: raw.symbol,
    clientAlgoId: raw.clientAlgoId,
    algoId: raw.algoId,
    type: raw.orderType,
    side: raw.side,
    triggerPrice: num(raw.triggerPrice),
    quantity: num(raw.quantity),
    status: raw.algoStatus,
    actualOrderId: raw.actualOrderId ? num(raw.actualOrderId) : null,
  }
}

export function toPosition(raw: RawPositionRisk): BinancePosition {
  const liquidation = num(raw.liquidationPrice)
  return {
    symbol: raw.symbol,
    amount: num(raw.positionAmt),
    entryPrice: num(raw.entryPrice),
    markPrice: num(raw.markPrice),
    liquidationPrice: liquidation > 0 ? liquidation : null,
    marginType: raw.marginType.toLowerCase() === 'isolated' ? 'isolated' : 'cross',
    isolatedMargin: num(raw.isolatedMargin),
    leverage: num(raw.leverage),
  }
}

export function toUserTrade(raw: RawUserTrade): UserTrade {
  return {
    id: raw.id,
    orderId: raw.orderId,
    symbol: raw.symbol,
    side: raw.side,
    price: num(raw.price),
    qty: num(raw.qty),
    commission: num(raw.commission),
    commissionAsset: raw.commissionAsset,
    realizedPnl: num(raw.realizedPnl),
    time: raw.time,
  }
}

export function toIncomeRow(raw: RawIncome): IncomeRow {
  return { symbol: raw.symbol, income: num(raw.income), time: raw.time, tranId: raw.tranId }
}

// Del lado seguro si un campo falta: futuros sólo si dice `true`, retiros salvo que diga `false`.
export function toApiRestrictions(raw: RawApiRestrictions): ApiRestrictions {
  return { enableFutures: raw.enableFutures === true, enableWithdrawals: raw.enableWithdrawals !== false, ipRestrict: raw.ipRestrict === true }
}
