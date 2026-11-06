// Qué cerró una posición del bot, buscado por REST cuando el stream no lo dijo (el bot estaba
// apagado, el evento se perdió en un corte o todavía no llegó). Los trades de cierre salen de
// `userTrades`; el motivo, de la orden que los generó: un algo del bot que disparó (por su
// `actualOrderId`), una liquidación (`autoclose-…`, `adl_autoclose`), el interruptor (`x`).

import type { Side } from '@sereno/core'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { UserTrade } from '../binance/trade-types'
import { parseClientId } from './client-id'
import { restFill, type OrderFill } from './order-tracker'
import type { PendingClose } from './pending-close'

export type TriggerLookupApi = Pick<BinanceTradeRest, 'queryAlgo' | 'userTrades'>
export type LookupTradeApi = TriggerLookupApi & Pick<BinanceTradeRest, 'queryOrderById' | 'userTradesBetween'>

export interface ClosingQuery {
  symbol: string
  side: Side
  qty: number
  // Desde cuándo buscar: la apertura de la posición.
  since: number
  until: number
  // Los stops y take profits del bot en la moneda (los que disparan se vinculan por éstos).
  clientAlgoIds: readonly string[]
  // El precio de liquidación conocido, para informar el disparo de una liquidación.
  liquidationPrice: number
  stepSize: number
}

// El cierre de un algo del bot que disparó: el primero de la lista con trades.
export async function triggeredByRest(trade: TriggerLookupApi, symbol: string, clientAlgoIds: readonly string[]): Promise<PendingClose | null> {
  for (const id of clientAlgoIds) {
    const algo = await trade.queryAlgo(id)
    if (!algo || algo.actualOrderId === null) continue
    const trades = await trade.userTrades(symbol, { orderId: algo.actualOrderId })
    if (trades.length === 0) continue
    return { reason: kindReason(id) ?? 'stop', fill: fillOfTrades(symbol, trades, id), triggerPrice: algo.triggerPrice, orderId: id }
  }
  return null
}

// Lo que cerró la posición de `query`, o null si Binance no muestra trades de cierre. `all`:
// los trades de `tradesSince` si quien llama ya los leyó.
export async function closingByRest(trade: LookupTradeApi, query: ClosingQuery, all?: readonly UserTrade[]): Promise<PendingClose | null> {
  return closeOf(trade, query, all ?? (await tradesSince(trade, query)))
}

// La posición del bot se cerró aunque Binance muestre ahora una del mismo lado (Toti abrió
// otra con el bot apagado). Lo prueban dos cosas: que disparó un stop o un take profit del
// bot, o que la moneda quedó en cero (o dio vuelta) en algún momento desde la apertura.
// Ventas que sumen la cantidad del bot no alcanzan: pueden ser de lo que Toti sumó. null si
// nada lo prueba (la posición sigue siendo del bot).
export async function closedUnderneath(trade: LookupTradeApi, query: ClosingQuery, amountNow: number, known?: readonly UserTrade[]): Promise<PendingClose | null> {
  const all = known ?? (await tradesSince(trade, query))
  for (const id of query.clientAlgoIds) {
    const algo = await trade.queryAlgo(id)
    if (algo?.actualOrderId == null) continue
    const own = all.filter((t) => t.orderId === algo.actualOrderId)
    if (own.length === 0) continue
    return { reason: kindReason(id) ?? 'stop', fill: fillOfTrades(query.symbol, own, id), triggerPrice: algo.triggerPrice, orderId: id }
  }
  return wentFlat(all, query, amountNow) ? closeOf(trade, query, all) : null
}

async function closeOf(trade: LookupTradeApi, query: ClosingQuery, all: readonly UserTrade[]): Promise<PendingClose | null> {
  const trades = closingTrades(all, query)
  if (trades.length === 0) return null
  const orderIds = new Set(trades.map((t) => t.orderId))
  const fill = fillOfTrades(query.symbol, trades, '')
  const whole = { wholePosition: true }
  // Primero los algos del bot: la orden que nace al disparar no lleva un id nuestro.
  for (const id of query.clientAlgoIds) {
    const algo = await trade.queryAlgo(id)
    if (algo?.actualOrderId != null && orderIds.has(algo.actualOrderId)) return { reason: kindReason(id) ?? 'stop', fill: { ...fill, clientOrderId: id }, triggerPrice: algo.triggerPrice, orderId: id, ...whole }
  }
  const last = trades.at(-1)!
  const order = await trade.queryOrderById(query.symbol, last.orderId)
  const clientOrderId = order?.clientOrderId ?? ''
  const closing = { ...fill, clientOrderId }
  if (clientOrderId.startsWith('autoclose-') || clientOrderId === 'adl_autoclose') return { reason: 'liquidation', fill: closing, triggerPrice: query.liquidationPrice, ...whole }
  const kind = parseClientId(clientOrderId)?.kind
  if (kind === 'x') return { reason: 'close_all', fill: closing, triggerPrice: fill.avgPrice, orderId: clientOrderId, ...whole }
  const reason = kindReason(clientOrderId)
  if (reason) return { reason, fill: closing, triggerPrice: fill.avgPrice, orderId: clientOrderId, ...whole }
  return { reason: 'closed_on_exchange', fill: closing, triggerPrice: fill.avgPrice, ...whole }
}

// Todos los trades de la moneda desde la apertura de la posición.
export function tradesSince(trade: Pick<LookupTradeApi, 'userTradesBetween'>, query: ClosingQuery): Promise<UserTrade[]> {
  return trade.userTradesBetween(query.symbol, query.since, query.until)
}

// Los trades que reducen la posición desde su apertura, en orden, hasta su cantidad (lo que
// sigue, de otra posición de Toti en la misma moneda, no es de esta).
function closingTrades(all: readonly UserTrade[], query: ClosingQuery): UserTrade[] {
  const closingSide = closingSideOf(query.side)
  const picked: UserTrade[] = []
  let remaining = query.qty
  for (const t of all.filter((t) => t.side === closingSide && t.time >= query.since).sort((a, b) => a.time - b.time || a.id - b.id)) {
    if (remaining <= query.stepSize / 2) break
    const qty = Math.min(t.qty, remaining)
    const share = qty / t.qty
    picked.push({ ...t, qty, commission: t.commission * share, realizedPnl: t.realizedPnl * share })
    remaining -= qty
  }
  return picked
}

// ¿La moneda quedó en cero o del otro lado después de algún trade desde la apertura? Se
// recorre hacia atrás desde la cantidad de ahora deshaciendo cada trade. Los del lado de la
// apertura hasta `since` son la apertura del bot (su fill termina en `since`).
function wentFlat(all: readonly UserTrade[], query: ClosingQuery, amountNow: number): boolean {
  const closingSide = closingSideOf(query.side)
  const after = all.filter((t) => t.time > query.since || (t.time === query.since && t.side === closingSide)).sort((a, b) => b.time - a.time || b.id - a.id)
  // En el sentido de la posición del bot: positivo es del mismo lado.
  let amount = (query.side === 'long' ? 1 : -1) * amountNow
  for (const t of after) {
    if (amount <= query.stepSize / 2) return true
    amount += t.side === closingSide ? t.qty : -t.qty
  }
  return false
}

export function fillOfTrades(symbol: string, trades: readonly UserTrade[], clientOrderId: string): OrderFill {
  const qty = trades.reduce((sum, t) => sum + t.qty, 0)
  const avgPrice = trades.reduce((sum, t) => sum + t.qty * t.price, 0) / qty
  const last = trades.at(-1)!
  return restFill({ symbol, orderId: last.orderId, clientOrderId, status: 'FILLED', executedQty: qty, avgPrice, updateTime: last.time }, trades)
}

function closingSideOf(side: Side): UserTrade['side'] {
  return side === 'long' ? 'SELL' : 'BUY'
}

function kindReason(clientId: string): 'stop' | 'take_profit' | null {
  const kind = parseClientId(clientId)?.kind
  if (kind === 's') return 'stop'
  if (kind === 't') return 'take_profit'
  return null
}
