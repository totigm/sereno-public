import type { Side } from '@sereno/core'
import type { ClosedPositionRecord, PositionRecord } from '@sereno/db'
import type { LivePayload, OpenPositionView } from '@/lib/live/types'
import type { SessionContext } from '@/lib/queries/session'
import { coinName } from './format'

// Lo que muestran una fila, una tarjeta y la cabecera de la hoja, venga el trade de
// la consulta en vivo (abierta, valuada a la marca) o del historial (cerrada).

export type TradeRecord = OpenPositionView | PositionRecord | ClosedPositionRecord

export function isClosed(trade: TradeRecord): trade is ClosedPositionRecord {
  return 'closedAt' in trade
}

export interface TradeSummary {
  id: string
  symbol: string
  /** "SOL": sin la moneda de cotización. */
  coin: string
  side: Side
  leverage: number
  closed: boolean
  /** Neto: lo realizado si cerró; lo que dejaría cerrarla ahora si está abierta. Null sin precio. */
  result: number | null
  /** `result / margen` (lo que Binance llama ROE). */
  pct: number | null
  r: number | null
  /** Marca vigente (abierta) o precio de salida (cerrada). */
  price: number | null
}

export function summarize(trade: TradeRecord): TradeSummary {
  const base = {
    id: trade.id,
    symbol: trade.symbol,
    coin: coinName(trade.symbol),
    side: trade.side,
    leverage: trade.leverage,
  }
  if (isClosed(trade)) {
    return {
      ...base,
      closed: true,
      result: trade.pnlNet,
      pct: trade.margin > 0 ? trade.pnlNet / trade.margin : null,
      r: trade.rMultiple,
      price: trade.exitPrice,
    }
  }
  const valuation = 'valuation' in trade ? trade.valuation : null
  return {
    ...base,
    closed: false,
    result: valuation?.net ?? null,
    pct: valuation?.pctOfMargin ?? null,
    r: valuation?.r ?? null,
    price: valuation?.mark ?? null,
  }
}

/** Dónde y cuándo se mira: decide el tiempo verbal, los valores apagados y si hay acciones. */
export interface TradeScope {
  sessionId: string
  /** La simulación activa: en presente y con acciones sobre el bot. */
  active: boolean
  /** Activa y sin latido hace más de 60 s: precios viejos (apagados) y acciones deshabilitadas. */
  offline: boolean
  /** Hora de los precios cuando no son de recién: sin conexión, o el final de una sesión terminada. */
  pricesAt: number | null
  /** "Ahora" de la sesión: el reloj de la base si está activa; su final si terminó. */
  now: number
  /** Reloj para "hoy" y "ayer": el de la base en la activa; null si terminó (fechas completas). */
  clock: number | null
}

export function tradeScope(context: SessionContext, live: LivePayload): TradeScope {
  const active = context.isActive
  const offline = active && live.offline
  const marksAt = live.market?.updatedAt ?? null
  return {
    sessionId: live.sessionId,
    active,
    offline,
    pricesAt: offline || !active ? marksAt : null,
    now: active || !context.session ? live.now : endOf(context.session.period.to, context.session.endedAt, live.now),
    clock: active ? live.now : null,
  }
}

// Lo mismo que `anchorOf` de las queries, que no se puede importar acá: arrastraría la base al cliente.
function endOf(periodTo: number | null, endedAt: number | null, fallback: number): number {
  return periodTo ?? endedAt ?? fallback
}
