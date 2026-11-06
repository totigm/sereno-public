import { and, asc, desc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from '../client'
import { realEvents, realReadiness, type RealEventKind } from '../schema'
import { dbNow, excluded } from './sql-helpers'

export type RealReadinessRow = typeof realReadiness.$inferSelect
// `checkedAt` lo sella la base (`now()`), como el latido: el dashboard mide si los
// chequeos están viejos contra el mismo reloj que los escribió.
export type RealReadinessInput = Omit<RealReadinessRow, 'checkedAt'>

export interface RealEventInput {
  // Instante del motor, en ms.
  at: number
  kind: RealEventKind
  symbol?: string | null
  phrase: string
  data?: Record<string, unknown>
}

export type RealEventRecord = Omit<typeof realEvents.$inferSelect, 'at'> & { at: number }

export function createRealReadinessRepo(db: Db) {
  return {
    // Una fila por entorno: la última corrida de chequeos pisa la anterior.
    async upsert(row: RealReadinessInput): Promise<void> {
      await db
        .insert(realReadiness)
        .values({ ...row, checkedAt: dbNow })
        .onConflictDoUpdate({
          target: realReadiness.env,
          set: {
            checkedAt: excluded(realReadiness.checkedAt),
            enabled: excluded(realReadiness.enabled),
            keysPresent: excluded(realReadiness.keysPresent),
            checks: excluded(realReadiness.checks),
            walletAvailable: excluded(realReadiness.walletAvailable),
            instanceId: excluded(realReadiness.instanceId),
          },
        })
    },

    // Los chequeos más nuevos, de cualquier entorno: los del bot que corre ahora.
    async latest(): Promise<RealReadinessRow | null> {
      const [row] = await db.select().from(realReadiness).orderBy(desc(realReadiness.checkedAt)).limit(1)
      return row ?? null
    },
  }
}

export function createRealEventsRepo(db: Db) {
  return {
    async append(sessionId: string, events: readonly RealEventInput[]): Promise<void> {
      if (events.length === 0) return
      await db.insert(realEvents).values(
        events.map((e) => ({ sessionId, at: new Date(e.at), kind: e.kind, symbol: e.symbol ?? null, phrase: e.phrase, data: e.data ?? {} })),
      )
    },

    // Los eventos de la sesión en [from, to), en orden.
    async list(sessionId: string, { from, to }: { from: number; to: number }): Promise<RealEventRecord[]> {
      const rows = await db
        .select()
        .from(realEvents)
        .where(and(eq(realEvents.sessionId, sessionId), gte(realEvents.at, new Date(from)), lt(realEvents.at, new Date(to))))
        .orderBy(asc(realEvents.at), asc(realEvents.id))
      return rows.map((r) => ({ ...r, at: r.at.getTime() }))
    },
  }
}

export type RealReadinessRepo = ReturnType<typeof createRealReadinessRepo>
export type RealEventsRepo = ReturnType<typeof createRealEventsRepo>
