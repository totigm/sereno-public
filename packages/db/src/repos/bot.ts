import { and, eq, gt, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../client'
import { botLease, botStatus } from '../schema'
import { dbNow, excluded, millis } from './sql-helpers'

export type BotStatusRow = typeof botStatus.$inferSelect
// El latido lo sella la base (`now()`): el dashboard mide "sin conexión" contra
// el mismo reloj que escribió.
export type HeartbeatInput = Omit<typeof botStatus.$inferInsert, 'lastHeartbeat'>

const leaseOfWriter = alias(botLease, 'writer_lease')

export function createBotRepo(db: Db) {
  return {
    // Reescribe la fila de estado de la sesión. Una instancia puede pisar su
    // propia fila o la de una que ya no tiene lease vigente; si no, dos procesos
    // se alternarían el estado cada 10 s. Devuelve si escribió.
    // Por eso un segundo proceso en `waiting_lease` casi nunca llega al
    // dashboard (hay una sola fila por sesión): con `false` sabe que no se lo
    // muestra a nadie, y "lo dice" (spec §10) en su propio log.
    async heartbeat(status: HeartbeatInput): Promise<boolean> {
      const holderIsAlive = sql`exists (${db
        .select({ one: sql`1` })
        .from(leaseOfWriter)
        .where(
          and(
            eq(leaseOfWriter.sessionId, botStatus.sessionId),
            eq(leaseOfWriter.instanceId, botStatus.instanceId),
            gt(leaseOfWriter.leaseUntil, dbNow),
          ),
        )})`
      const written = await db
        .insert(botStatus)
        .values({ ...status, lastHeartbeat: dbNow })
        .onConflictDoUpdate({
          target: botStatus.sessionId,
          set: {
            instanceId: excluded(botStatus.instanceId),
            lastHeartbeat: excluded(botStatus.lastHeartbeat),
            phase: excluded(botStatus.phase),
            warmProgress: excluded(botStatus.warmProgress),
            universeSize: excluded(botStatus.universeSize),
            lastCycleAt: excluded(botStatus.lastCycleAt),
            settingsVersionApplied: excluded(botStatus.settingsVersionApplied),
            degradedSymbols: excluded(botStatus.degradedSymbols),
            flags: excluded(botStatus.flags),
            recentErrors: excluded(botStatus.recentErrors),
            botVersion: excluded(botStatus.botVersion),
            real: excluded(botStatus.real),
          },
          setWhere: sql`${botStatus.instanceId} = ${excluded(botStatus.instanceId)} or not ${holderIsAlive}`,
        })
        .returning({ sessionId: botStatus.sessionId })
      return written.length > 0
    },

    // Instancia única (spec §10, §12): toma el lease si está libre, si venció o
    // si ya es suyo (renovación). Una sola sentencia, sin carrera entre procesos.
    async acquireLease(sessionId: string, instanceId: string, ttlMs: number): Promise<boolean> {
      const taken = await db
        .insert(botLease)
        .values({ sessionId, instanceId, leaseUntil: sql`now() + ${millis(ttlMs)}` })
        .onConflictDoUpdate({
          target: botLease.sessionId,
          set: { instanceId: excluded(botLease.instanceId), leaseUntil: excluded(botLease.leaseUntil) },
          setWhere: sql`${botLease.instanceId} = ${excluded(botLease.instanceId)} or ${botLease.leaseUntil} < ${dbNow}`,
        })
        .returning({ sessionId: botLease.sessionId })
      return taken.length > 0
    },

    // Al apagarse ordenadamente: el siguiente proceso no espera a que venza.
    async releaseLease(sessionId: string, instanceId: string): Promise<boolean> {
      const released = await db
        .delete(botLease)
        .where(and(eq(botLease.sessionId, sessionId), eq(botLease.instanceId, instanceId)))
        .returning({ sessionId: botLease.sessionId })
      return released.length > 0
    },

    async get(sessionId: string): Promise<BotStatusRow | null> {
      const [row] = await db.select().from(botStatus).where(eq(botStatus.sessionId, sessionId))
      return row ?? null
    },
  }
}

export type BotRepo = ReturnType<typeof createBotRepo>
