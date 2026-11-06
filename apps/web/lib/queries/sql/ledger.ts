import { and, eq, inArray, sql } from 'drizzle-orm'
import { positions, type Db } from '@sereno/db'
import { asNumber } from './fields'

export interface LedgerTotals {
  closedCount: number
  wonCount: number
  /** Suma de `pnlNet` de las cerradas. */
  realizedClosed: number
  /** Comisiones y funding ya pagados por las abiertas (entran al saldo antes de cerrar). */
  openCosts: number
}

const closed = sql`${positions.closedAt} is not null`

const totals = {
  closedCount: asNumber(sql`count(*) filter (where ${closed})`),
  // Mismo criterio que las estadísticas: ganado si pnlNet > 0.
  wonCount: asNumber(sql`count(*) filter (where ${closed} and ${positions.pnlNet} > 0)`),
  realizedClosed: asNumber(sql`coalesce(sum(${positions.pnlNet}) filter (where ${closed}), 0)`),
  openCosts: asNumber(sql`coalesce(sum(${positions.fees} + ${positions.funding}) filter (where ${positions.closedAt} is null), 0)`),
}

/** Totales de la cartera real (o de la sombra) de una sesión, en una sola pasada. */
export async function readLedgerTotals(db: Db, sessionId: string, { shadow = false } = {}): Promise<LedgerTotals> {
  const [row] = await db
    .select(totals)
    .from(positions)
    .where(and(eq(positions.sessionId, sessionId), eq(positions.shadow, shadow)))
  return row ?? { closedCount: 0, wonCount: 0, realizedClosed: 0, openCosts: 0 }
}

/** Los mismos totales de la cartera real para varias sesiones (listas de replays y archivadas). */
export async function readLedgerTotalsBySession(db: Db, sessionIds: readonly string[]): Promise<Map<string, LedgerTotals>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await db
    .select({ sessionId: positions.sessionId, ...totals })
    .from(positions)
    .where(and(inArray(positions.sessionId, [...sessionIds]), eq(positions.shadow, false)))
    .groupBy(positions.sessionId)
  return new Map(rows.map(({ sessionId, ...t }) => [sessionId, t]))
}

/** saldo = I₀ + resultado realizado (cerradas, comisiones y funding), spec §7. */
export function saldoOf(capitalInicial: number, t: LedgerTotals): number {
  return capitalInicial + t.realizedClosed - t.openCosts
}
