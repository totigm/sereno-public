import { cache } from 'react'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { Candle, SignalId } from '@sereno/core'
import { effectiveWeights } from '@sereno/core/src/learning/weights'
import { positions, type ClosedFilters, type ClosedPositionRecord, type PositionEventRow, type PositionRecord } from '@sereno/db'
import { startOfDayBA, type PositionEventKind } from '@sereno/shared'
import { db, repos } from '../db'
import type { LivePayload } from '../live/types'
import { getBooks, getLearning, getLive } from './books'
import { anchorOf, getSessionView, type SessionView } from './session'
import { statsView, verdictView, type StatsView, type VerdictView } from './stats'

export const CLOSED_PAGE_SIZE = 50

// Filtros del historial tal como llegan en la URL (`?moneda=SOLUSDT&lado=long&resultado=perdidas&liquidadas=1&pagina=2&trade=<id>`).
export const PosicionesQuerySchema = z.object({
  moneda: z.string().min(1).max(40).optional(),
  lado: z.enum(['long', 'short']).optional(),
  resultado: z.enum(['ganadas', 'perdidas']).optional(),
  liquidadas: z.literal('1').optional(),
  pagina: z.coerce.number().int().min(1).max(10_000).optional(),
  trade: z.string().min(1).max(200).optional(),
})

export type PosicionesQuery = z.infer<typeof PosicionesQuerySchema>

/** Los `searchParams` de la página, validados; lo inválido se ignora en vez de romper la pantalla. */
export function parsePosicionesQuery(searchParams: Record<string, string | string[] | undefined>): PosicionesQuery {
  const flat = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(PosicionesQuerySchema.shape)) {
    const parsed = schema.safeParse(flat[key])
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data
  }
  return out as PosicionesQuery
}

export type ClosedTradeView = ClosedPositionRecord & {
  /** 00:00 (Buenos Aires) del día del cierre: la clave para agrupar el historial por día. */
  day: number
}

export interface PositionEventView {
  id: number
  kind: PositionEventKind
  payload: Record<string, unknown>
  at: number
}

export interface TradeDetail {
  position: PositionRecord | ClosedPositionRecord
  closed: boolean
  events: PositionEventView[]
  /**
   * Velas de 15 m (último precio) desde 4 h antes de la entrada hasta 4 h después de la salida,
   * sin pasar del "ahora" de la sesión: en una que terminó, sólo las que cerraron hasta su final.
   */
  candles: Candle[]
  /** Las señales al abrir con el peso efectivo vigente de la moneda (los pesos de ese momento no se guardan). */
  signals: { id: SignalId; value: number | null; weight: number }[]
}

export interface PosicionesData {
  session: SessionView
  live: LivePayload
  closed: {
    items: ClosedTradeView[]
    hasMore: boolean
    page: number
    pageSize: number
    query: PosicionesQuery
    /** Monedas con algún trade cerrado, para el filtro. */
    symbols: string[]
  }
  stats: StatsView
  verdict: VerdictView
  /** El trade de `?trade=`, si existe en esta sesión. */
  trade: TradeDetail | null
}

const CANDLE_PAD_MS = 4 * 3_600_000

function filtersOf(q: PosicionesQuery): ClosedFilters {
  return {
    ...(q.moneda === undefined ? {} : { symbol: q.moneda }),
    ...(q.lado === undefined ? {} : { side: q.lado }),
    ...(q.resultado === undefined ? {} : { result: q.resultado === 'ganadas' ? 'won' : 'lost' }),
    ...(q.liquidadas === undefined ? {} : { liquidated: true }),
  }
}

export const getPosicionesData = cache(async (sessionId: string, query: PosicionesQuery = {}): Promise<PosicionesData | null> => {
  const [session, live] = await Promise.all([getSessionView(sessionId), getLive(sessionId)])
  if (!session || !live) return null
  const page = query.pagina ?? 1
  const [books, history, symbols, trade] = await Promise.all([
    getBooks(sessionId),
    repos.positions.listClosed(sessionId, filtersOf(query), { limit: CLOSED_PAGE_SIZE, offset: (page - 1) * CLOSED_PAGE_SIZE }),
    closedSymbols(sessionId),
    query.trade === undefined ? null : getTradeDetail(session, query.trade, live),
  ])
  const unrealized = live.open.reduce((sum, p) => sum + (p.valuation.unrealized ?? 0), 0)

  return {
    session,
    live,
    closed: {
      items: history.items.map((c) => ({ ...c, day: startOfDayBA(c.closedAt) })),
      hasMore: history.hasMore,
      page,
      pageSize: CLOSED_PAGE_SIZE,
      query,
      symbols,
    },
    stats: statsView(books.real, books.drawdown),
    verdict: verdictView({
      real: books.real,
      shadowTrades: books.shadow.length,
      days: session.days,
      drawdown: books.drawdown,
      capitalInicial: session.capitalInicial,
      equity: live.ledger.saldo + unrealized,
      shadowEquity: live.equityLast?.shadowEquity ?? null,
      seed: sessionId,
    }),
    trade,
  }
})

async function closedSymbols(sessionId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: positions.symbol })
    .from(positions)
    .where(and(eq(positions.sessionId, sessionId), eq(positions.shadow, false), isNotNull(positions.closedAt)))
    .orderBy(asc(positions.symbol))
  return rows.map((r) => r.symbol)
}

/**
 * El detalle de un trade de la sesión (abierto o cerrado, real); null si no es de esta sesión.
 * Las velas no pasan del "ahora" de la sesión (`anchorOf`: su final, si terminó). En una que
 * terminó van sólo las que cerraron hasta ahí: la que estaba en curso cierra después y su
 * máximo, su mínimo y su cierre traen mercado que la sesión no vivió. En la activa, la vela en
 * curso es el mercado de ahora y va.
 * Los ajustes dan el K de encogimiento: el mismo peso que la hoja de la moneda.
 */
export async function getTradeDetail(
  session: SessionView,
  positionId: string,
  live: Pick<LivePayload, 'now' | 'settings'>,
): Promise<TradeDetail | null> {
  // Las cerradas ya están leídas para las estadísticas (`getBooks` se lee una vez por pedido).
  const [open, books] = await Promise.all([repos.positions.listOpen(session.id), getBooks(session.id)])
  const closedTrade = books.real.find((p) => p.id === positionId)
  const position = closedTrade ?? open.find((p) => p.id === positionId)
  if (!position) return null
  const now = anchorOf(session, live.now)
  const until = closedTrade ? Math.min(closedTrade.closedAt + CANDLE_PAD_MS, now) : now
  const [events, candles, learning] = await Promise.all([
    repos.positions.listEvents(positionId),
    repos.candles.range(position.symbol, '15m', 'last', position.openedAt - CANDLE_PAD_MS, until),
    getLearning(session.id, session.startedAt),
  ])
  const weights = effectiveWeights(learning.state, position.symbol, live.settings?.learning.shrinkageK)
  return {
    position,
    closed: closedTrade !== undefined,
    events: events.map(toEventView),
    candles: session.status === 'active' ? candles : candles.filter((c) => c.closeTime <= now),
    signals: position.signalsAtOpen.map((s) => ({ id: s.id, value: s.value, weight: weights[s.id] })),
  }
}

function toEventView(e: PositionEventRow): PositionEventView {
  return { id: e.id, kind: e.kind, payload: e.payload, at: e.at.getTime() }
}
