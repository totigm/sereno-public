// De los mensajes del user data stream (`trade-types.ts`, campos verificados) a los eventos
// normalizados que emite `UserDataStream`. Un evento que no se usa devuelve null; uno que se
// usa pero llega mal formado tira (`num` corta antes de dejar pasar un NaN).

import { num } from './numbers'
import type { AccountUpdate, AlgoUpdate, MarginType, OrderTradeUpdate, RawAccountUpdate, RawAlgoUpdate, RawListenKeyExpired, RawOrderTradeUpdate } from './trade-types'
import { isObject } from './types'

export type UserEvent =
  | { kind: 'order'; update: OrderTradeUpdate }
  | { kind: 'algo'; update: AlgoUpdate }
  | { kind: 'account'; update: AccountUpdate }
  | { kind: 'expired'; listenKey: string }

// Ids de cliente que Binance les pone a sus propias órdenes de cierre forzado.
const LIQUIDATION_PREFIX = 'autoclose-'
const ADL_CLIENT_ID = 'adl_autoclose'

export function parseUserEvent(message: unknown): UserEvent | null {
  if (!isObject(message)) return null
  switch (message.e) {
    case 'ORDER_TRADE_UPDATE':
      return { kind: 'order', update: toOrderTradeUpdate(shaped<RawOrderTradeUpdate>(message, 'o')) }
    case 'ALGO_UPDATE':
      return { kind: 'algo', update: toAlgoUpdate(shaped<RawAlgoUpdate>(message, 'o')) }
    case 'ACCOUNT_UPDATE':
      return { kind: 'account', update: toAccountUpdate(shaped<RawAccountUpdate>(message, 'a')) }
    case 'listenKeyExpired': {
      const { listenKey } = message as unknown as RawListenKeyExpired
      if (typeof listenKey !== 'string') throw new TypeError('Binance: listenKeyExpired sin listenKey')
      return { kind: 'expired', listenKey }
    }
    default:
      return null
  }
}

export function isLiquidationClientId(clientOrderId: string): boolean {
  return clientOrderId.startsWith(LIQUIDATION_PREFIX) || clientOrderId === ADL_CLIENT_ID
}

function shaped<T>(message: Record<string, unknown>, body: string): T {
  if (!isObject(message[body])) throw new TypeError(`Binance: ${String(message.e)} sin "${body}"`)
  return message as unknown as T
}

function toOrderTradeUpdate(raw: RawOrderTradeUpdate): OrderTradeUpdate {
  const o = raw.o
  return {
    symbol: o.s,
    clientOrderId: o.c,
    orderId: num(o.i),
    side: o.S,
    origType: o.ot,
    status: o.X,
    execType: o.x,
    lastQty: num(o.l),
    lastPrice: num(o.L),
    avgPrice: num(o.ap),
    cumQty: num(o.z),
    commission: o.n === undefined ? 0 : num(o.n),
    commissionAsset: o.N ?? null,
    realizedPnl: num(o.rp),
    reduceOnly: o.R === true,
    at: num(raw.T),
    liquidation: isLiquidationClientId(o.c),
  }
}

function toAlgoUpdate(raw: RawAlgoUpdate): AlgoUpdate {
  const o = raw.o
  return {
    symbol: o.s,
    clientAlgoId: o.caid,
    algoId: num(o.aid),
    type: o.o,
    side: o.S,
    triggerPrice: num(o.tp),
    quantity: num(o.q),
    status: o.X,
    triggeredOrderId: o.ai === '' || o.ai === undefined ? null : num(o.ai),
    at: num(raw.T),
  }
}

function toAccountUpdate(raw: RawAccountUpdate): AccountUpdate {
  const positions = Array.isArray(raw.a.P) ? raw.a.P : []
  return {
    reason: raw.a.m,
    at: num(raw.T),
    positions: positions.map((p) => ({
      symbol: p.s,
      amount: num(p.pa),
      entryPrice: num(p.ep),
      marginType: marginType(p.mt),
      isolatedMargin: num(p.iw),
      unrealizedPnl: num(p.up),
    })),
  }
}

function marginType(raw: string): MarginType {
  return raw.toLowerCase() === 'isolated' ? 'isolated' : 'cross'
}
