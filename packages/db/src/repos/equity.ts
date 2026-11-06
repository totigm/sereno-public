import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { EquitySnapshotKind } from '@sereno/shared'
import type { Db } from '../client'
import { equitySnapshots, sessions } from '../schema'
import { asList, chunks } from './sql-helpers'

type EquityRow = typeof equitySnapshots.$inferSelect

// Un punto de la curva de capital, con el instante en ms como lo da el motor.
export type EquityPoint = Omit<EquityRow, 'id' | 'sessionId' | 'at'> & { at: number }
export type EquityRecord = EquityPoint & { id: number; sessionId: string }

function toRecord(r: EquityRow): EquityRecord {
  return { ...r, at: r.at.getTime() }
}

function inRange(sessionId: string, from: number, to: number) {
  return and(eq(equitySnapshots.sessionId, sessionId), gte(equitySnapshots.at, new Date(from)), lt(equitySnapshots.at, new Date(to)))
}

export function createEquityRepo(db: Db) {
  return {
    async insert(sessionId: string, points: EquityPoint | readonly EquityPoint[]): Promise<void> {
      // 10 columnas por fila.
      for (const part of chunks(asList(points), 2000)) {
        await db.insert(equitySnapshots).values(part.map((p) => ({ ...p, sessionId, at: new Date(p.at) })))
      }
    },

    // La curva en [from, to), en orden; sin `kind`, por minuto y por evento juntas.
    async series(sessionId: string, from: number, to: number, kind?: EquitySnapshotKind): Promise<EquityRecord[]> {
      const rows = await db
        .select()
        .from(equitySnapshots)
        .where(
          and(
            eq(equitySnapshots.sessionId, sessionId),
            gte(equitySnapshots.at, new Date(from)),
            lt(equitySnapshots.at, new Date(to)),
            kind === undefined ? undefined : eq(equitySnapshots.kind, kind),
          ),
        )
        .orderBy(asc(equitySnapshots.at), asc(equitySnapshots.id))
      return rows.map(toRecord)
    },

    // El máximo de la equity en [from, to); null sin puntos.
    async peak(sessionId: string, from: number, to: number): Promise<number | null> {
      const [row] = await db
        .select({ peak: sql<number | null>`max(${equitySnapshots.equity})` })
        .from(equitySnapshots)
        .where(inRange(sessionId, from, to))
      return row?.peak ?? null
    },

    // Si algún punto de [from, to) cae `maxDrawdown` o más desde el pico corrido, con la
    // regla de `accountRules`: el pico arranca en `priorPeak` (el de antes de `from`, null
    // si no había) y sube con cada punto en el orden de la curva. Lo calcula la base: al
    // retomar no hace falta traer la curva entera.
    async drawdownHit(sessionId: string, w: { from: number; to: number; priorPeak: number | null; maxDrawdown: number }): Promise<boolean> {
      const running = db
        .select({
          equity: equitySnapshots.equity,
          peak: sql<number>`greatest(${w.priorPeak}::float8, max(${equitySnapshots.equity}) over (order by ${equitySnapshots.at}, ${equitySnapshots.id} rows between unbounded preceding and current row))`.as(
            'peak',
          ),
        })
        .from(equitySnapshots)
        .where(inRange(sessionId, w.from, w.to))
        .as('running')
      const hits = await db
        .select({ equity: running.equity })
        .from(running)
        .where(sql`${running.peak} > 0 and (${running.peak} - ${running.equity}) / ${running.peak} >= ${w.maxDrawdown}::float8`)
        .limit(1)
      return hits.length > 0
    },

    // El último punto de la sesión (lo que muestra `/api/live`).
    async latest(sessionId: string): Promise<EquityRecord | null> {
      const [row] = await db
        .select()
        .from(equitySnapshots)
        .where(eq(equitySnapshots.sessionId, sessionId))
        .orderBy(desc(equitySnapshots.at), desc(equitySnapshots.id))
        .limit(1)
      return row ? toRecord(row) : null
    },

    // Limpieza diaria (spec §10): los puntos por minuto de las sesiones en vivo
    // duran 90 días; los de evento y los de replays, siempre. Devuelve cuántos borró.
    async pruneMinuteOlderThan(cutoff: number): Promise<number> {
      const live = db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.kind, ['paper_live', 'live']))
      const deleted = await db
        .delete(equitySnapshots)
        .where(
          and(
            eq(equitySnapshots.kind, 'minute'),
            lt(equitySnapshots.at, new Date(cutoff)),
            inArray(equitySnapshots.sessionId, live),
          ),
        )
        .returning({ id: equitySnapshots.id })
      return deleted.length
    },
  }
}

export type EquityRepo = ReturnType<typeof createEquityRepo>
