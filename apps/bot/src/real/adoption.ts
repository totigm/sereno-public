// Una posición de Binance que la base no conoce es del bot sólo si la explica un fill `o` de
// la sesión: el bot se cayó entre la orden y el guardado. La usan el arranque (para adoptarla)
// y `pnpm bot real-off` (para cerrarla igual que a las demás del bot).
//
// Una adoptada, por definición, no tiene stop: el arranque se lo pone en el acto
// (`placeAdoptedStop`), sin esperar al motor ni al primer precio por REST.

import type { Position, SymbolInfo } from '@sereno/core'
import { closingSide } from '@sereno/core/src/exchange/sides'
import { formatPrice, formatQty } from '../binance/precision'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { OrderSide } from '../binance/trade-types'
import type { Clock } from '../live/timers'
import { parseClientId, type ClientIds } from './client-id'
import { fillOfTrades, type LookupTradeApi } from './closing-fill'
import type { OrderFill } from './order-tracker'
import { withRetries } from './retry'

export interface AdoptedStopDeps {
  trade: Pick<BinanceTradeRest, 'algoOrder'>
  ids: Pick<ClientIds, 'next'>
  clock: Clock
  delaysMs: readonly number[]
}

// Hasta dónde se busca el fill `o` (una ventana de `userTrades`): el bot se cae entre la orden
// y el guardado, no días antes.
const ADOPTION_LOOKBACK_MS = 7 * 24 * 3_600_000 - 1
const QTY_TOLERANCE = 1e-9
// Margen sobre el reloj local para el fin de la búsqueda de trades (relojes desfasados).
const CLOCK_SKEW_MS = 60_000

// El fill `o` de la sesión `short` que explica la posición de Binance (`amount`, con signo): la
// apertura del bot más reciente en la moneda, del mismo lado y sin nada que la haya reducido
// después. Lo que Toti sumó a mano del mismo lado no la invalida (lo maneja él); una venta o un
// cierre después, sí (ese `o` ya se cerró y lo de ahora es de otro). null si nada la explica.
export async function adoptionFill(trade: LookupTradeApi, symbol: string, amount: number, short: string, now: number): Promise<OrderFill | null> {
  const opening: OrderSide = amount > 0 ? 'BUY' : 'SELL'
  const endTime = now + CLOCK_SKEW_MS
  const trades = await trade.userTradesBetween(symbol, endTime - ADOPTION_LOOKBACK_MS, endTime)
  const checked = new Set<number>()
  for (const t of [...trades].sort((a, b) => b.time - a.time || b.id - a.id)) {
    if (t.side !== opening) return null
    if (checked.has(t.orderId)) continue
    checked.add(t.orderId)
    const order = await trade.queryOrderById(symbol, t.orderId)
    if (!order) continue
    const parsed = parseClientId(order.clientOrderId)
    if (parsed?.short !== short || parsed.kind !== 'o') continue
    // Todos los trades de esa orden, aunque haya otros en medio.
    const own = trades.filter((r) => r.orderId === t.orderId).sort((a, b) => a.time - b.time || a.id - b.id)
    const fill = fillOfTrades(symbol, own, order.clientOrderId)
    return fill.qty <= Math.abs(amount) + QTY_TOLERANCE ? fill : null
  }
  return null
}

// El stop de la adoptada, como lo pone el adaptador: algorítmico, `reduceOnly` por la cantidad
// del bot y disparado por la marca. El motor lo reutiliza al protegerla (mismo precio y
// cantidad). Lo que Binance rechace sale tal cual: quien llama lo avisa y el motor lo vuelve
// a intentar con el primer precio (y si tampoco puede, la cierra).
export async function placeAdoptedStop(deps: AdoptedStopDeps, position: Position, info: SymbolInfo): Promise<string> {
  const clientAlgoId = deps.ids.next('s')
  const order = {
    symbol: position.symbol,
    side: closingSide(position.side) === 'buy' ? 'BUY' : 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: formatPrice(position.stopPrice, info.tickSize),
    quantity: formatQty(position.qty, info.stepSize),
    clientAlgoId,
  } as const
  await withRetries(deps.clock, deps.delaysMs, () => deps.trade.algoOrder(order))
  return clientAlgoId
}
