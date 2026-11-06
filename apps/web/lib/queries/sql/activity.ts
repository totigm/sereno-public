import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { decisions, positionEvents, positions, type Db } from '@sereno/db'
import type { PositionEventKind } from '@sereno/shared'
import { asNumber } from './fields'

export interface WindowEvent {
  id: number
  positionId: string
  kind: PositionEventKind
  payload: Record<string, unknown>
  at: number
  symbol: string
  side: 'long' | 'short'
  margin: number
}

/** Eventos de las posiciones reales de la sesión en [from, to), en orden. */
export async function positionEventsIn(
  db: Db,
  sessionId: string,
  from: number,
  to: number,
  kinds: readonly PositionEventKind[],
): Promise<WindowEvent[]> {
  const rows = await db
    .select({
      id: positionEvents.id,
      positionId: positionEvents.positionId,
      kind: positionEvents.kind,
      payload: positionEvents.payload,
      at: positionEvents.at,
      symbol: positions.symbol,
      side: positions.side,
      margin: positions.margin,
    })
    .from(positionEvents)
    .innerJoin(positions, eq(positions.id, positionEvents.positionId))
    .where(
      and(
        eq(positions.sessionId, sessionId),
        eq(positions.shadow, false),
        inArray(positionEvents.kind, [...kinds]),
        gte(positionEvents.at, new Date(from)),
        lt(positionEvents.at, new Date(to)),
      ),
    )
    .orderBy(asc(positionEvents.at), asc(positionEvents.id))
  return rows.map((r) => ({ ...r, at: r.at.getTime() }))
}

export interface CycleCounts {
  /** Cierres de vela evaluados ("Miré 30 monedas 32 veces"). */
  cycles: number
  coins: number
}

export async function decisionCycles(db: Db, sessionId: string, from: number, to: number): Promise<CycleCounts> {
  const [row] = await db
    .select({
      cycles: asNumber(sql`count(distinct ${decisions.candleCloseTime})`),
      coins: asNumber(sql`count(distinct ${decisions.symbol})`),
    })
    .from(decisions)
    .where(
      and(eq(decisions.sessionId, sessionId), gte(decisions.candleCloseTime, new Date(from)), lt(decisions.candleCloseTime, new Date(to))),
    )
  return row ?? { cycles: 0, coins: 0 }
}
