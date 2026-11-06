// Los eventos del user data stream que emite el Binance falso, con los campos exactos de
// Binance (`trade-types.ts`). Se arman acá desde las órdenes del falso.

import type { RawAccountUpdate, RawAlgoOrder, RawAlgoUpdate, RawOrder, RawOrderTradeUpdate } from '../trade-types'

export interface TradeFill {
  qty: string
  price: string
  commission: string
  realizedPnl: string
  tradeId: number
}

export function orderUpdate(order: RawOrder, execType: string, at: number, fill: TradeFill | null, expiryReason = '0'): RawOrderTradeUpdate {
  return {
    e: 'ORDER_TRADE_UPDATE',
    E: at,
    T: at,
    o: {
      s: order.symbol,
      c: order.clientOrderId,
      S: order.side,
      o: order.type,
      f: order.timeInForce,
      q: order.origQty,
      p: order.price,
      ap: order.avgPrice ?? '0',
      sp: order.stopPrice,
      x: execType,
      X: order.status,
      i: order.orderId,
      l: fill?.qty ?? '0',
      z: order.executedQty,
      L: fill?.price ?? '0',
      ...(fill ? { N: 'USDT', n: fill.commission } : {}),
      T: at,
      t: fill?.tradeId ?? 0,
      b: '0',
      a: '0',
      m: false,
      R: order.reduceOnly,
      wt: order.workingType,
      ot: order.origType,
      ps: order.positionSide,
      cp: order.closePosition,
      rp: fill?.realizedPnl ?? '0',
      pP: order.priceProtect,
      si: 0,
      ss: 0,
      V: order.selfTradePreventionMode,
      pm: order.priceMatch,
      gtd: order.goodTillDate,
      er: expiryReason,
    },
  }
}

export function algoUpdate(algo: RawAlgoOrder, at: number, reason = ''): RawAlgoUpdate {
  const triggered = algo.actualOrderId !== undefined && algo.actualOrderId !== ''
  return {
    e: 'ALGO_UPDATE',
    T: at,
    E: at,
    o: {
      caid: algo.clientAlgoId,
      aid: algo.algoId,
      at: algo.algoType,
      o: algo.orderType,
      s: algo.symbol,
      S: algo.side,
      ps: algo.positionSide,
      f: algo.timeInForce,
      q: algo.quantity,
      X: algo.algoStatus,
      ai: algo.actualOrderId ?? '',
      ...(triggered ? { ap: algo.actualPrice ?? '0', aq: algo.actualQty ?? '0', act: algo.actualType ?? 'MARKET' } : {}),
      tp: algo.triggerPrice,
      p: algo.price,
      V: algo.selfTradePreventionMode,
      wt: algo.workingType,
      pm: algo.priceMatch,
      cp: algo.closePosition,
      pP: algo.priceProtect,
      R: algo.reduceOnly,
      tt: algo.triggerTime,
      gtd: algo.goodTillDate,
      rm: reason,
      ia: false,
    },
  }
}

export interface AccountPosition {
  symbol: string
  amount: string
  entryPrice: string
  unrealized: string
  marginType: 'isolated' | 'cross'
  isolatedWallet: string
}

export function accountUpdate(reason: string, at: number, wallet: string, positions: AccountPosition[], fundingSymbol?: string): RawAccountUpdate {
  return {
    e: 'ACCOUNT_UPDATE',
    E: at,
    T: at,
    a: {
      m: reason,
      B: [{ a: 'USDT', wb: wallet, cw: wallet, bc: '0' }],
      P: positions.map((p) => ({ s: p.symbol, pa: p.amount, ep: p.entryPrice, bep: p.entryPrice, cr: '0', up: p.unrealized, mt: p.marginType, iw: p.isolatedWallet, ps: 'BOTH' })),
      ...(fundingSymbol ? { S: fundingSymbol } : {}),
    },
  }
}
