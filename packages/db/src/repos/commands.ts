import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { COMMAND_TTL_MS, CommandSchema, isPriceSensitive, type CommandInput } from '@sereno/shared'
import type { Db } from '../client'
import { botCommands, type CommandResult } from '../schema'
import { dbNow, millis } from './sql-helpers'

export type CommandRow = typeof botCommands.$inferSelect

// `not_pending`: el bot ya lo tomó (o ya terminó, venció o se canceló antes).
export type CancelOutcome = 'cancelled' | 'not_pending' | 'other_session' | 'not_found'

const isPending = eq(botCommands.status, 'pending')
const isClaimed = eq(botCommands.status, 'claimed')

const ABANDONED: CommandResult = { ok: false, message: 'El bot se reinició antes de terminarlo. Si todavía hace falta, pedilo de nuevo.' }
const notExpired = or(isNull(botCommands.expiresAt), gt(botCommands.expiresAt, dbNow))

// Cola de comandos del dashboard al bot (spec §10). Todo cambio de estado es una
// sola sentencia condicionada al estado anterior: nunca se lee y después se escribe.
export function createCommandsRepo(db: Db) {
  return {
    // Valida con el mismo zod que el dashboard. Devuelve false si el uuid ya
    // estaba: reintentar un envío nunca duplica el comando.
    async enqueue(input: CommandInput): Promise<boolean> {
      const cmd = CommandSchema.parse(input)
      const expiresAt = isPriceSensitive(cmd.kind) ? sql<Date>`now() + ${millis(COMMAND_TTL_MS)}` : null
      const inserted = await db
        .insert(botCommands)
        .values({
          id: cmd.id,
          sessionId: cmd.sessionId,
          kind: cmd.kind,
          payload: cmd.payload,
          requestedBy: cmd.requestedBy,
          // `now()` es el inicio de la transacción: el mismo instante para las dos.
          createdAt: dbNow,
          expiresAt,
        })
        .onConflictDoNothing({ target: botCommands.id })
        .returning({ id: botCommands.id })
      return inserted.length > 0
    },

    // El claim atómico de la spec §10: una sola sentencia; `SKIP LOCKED` hace que
    // dos bots en paralelo nunca reciban el mismo comando ni se esperen entre sí.
    async claimNext(sessionId: string, instanceId: string): Promise<CommandRow | null> {
      const next = db
        .select({ id: botCommands.id })
        .from(botCommands)
        .where(and(eq(botCommands.sessionId, sessionId), isPending, notExpired))
        .orderBy(asc(botCommands.createdAt), asc(botCommands.id))
        .limit(1)
        .for('update', { skipLocked: true })
      const [claimed] = await db
        .update(botCommands)
        .set({ status: 'claimed', claimedAt: dbNow, claimedBy: instanceId })
        .where(eq(botCommands.id, sql`(${next})`))
        .returning()
      return claimed ?? null
    },

    // Los vencidos se marcan sin ejecutarse; devuelve cuántos.
    async expireStale(sessionId: string): Promise<number> {
      const expired = await db
        .update(botCommands)
        .set({ status: 'expired', finishedAt: dbNow })
        .where(and(eq(botCommands.sessionId, sessionId), isPending, lte(botCommands.expiresAt, dbNow)))
        .returning({ id: botCommands.id })
      return expired.length
    },

    // Cierra un comando reclamado: `done` si salió bien, `failed` si no (un
    // `Error` se guarda como `{ ok: false, message }`).
    async finish(id: string, outcome: CommandResult | Error): Promise<boolean> {
      const result: CommandResult = outcome instanceof Error ? { ok: false, message: outcome.message } : outcome
      const finished = await db
        .update(botCommands)
        .set({ status: result.ok ? 'done' : 'failed', result, finishedAt: dbNow })
        .where(and(eq(botCommands.id, id), isClaimed))
        .returning({ id: botCommands.id })
      return finished.length > 0
    },

    // Los que un bot reclamó y nunca terminó porque se cayó. Lo llama el bot al
    // arrancar, ya con el lease tomado, así no hay otra instancia trabajándolos.
    // Quedan `failed` y no se reintentan: un cierre a medias repetido podría
    // cerrar de más. Devuelve cuántos.
    async failStaleClaims(sessionId: string, olderThanMs: number): Promise<number> {
      const failed = await db
        .update(botCommands)
        .set({ status: 'failed', result: ABANDONED, finishedAt: dbNow })
        .where(and(eq(botCommands.sessionId, sessionId), isClaimed, lte(botCommands.claimedAt, sql`now() - ${millis(olderThanMs)}`)))
        .returning({ id: botCommands.id })
      return failed.length
    },

    // Sólo se puede cancelar lo que el bot todavía no tomó, y sólo desde la sesión del
    // comando. Si no cancela, relee la fila para decir por qué (la lectura no decide nada).
    async cancel(id: string, sessionId: string): Promise<CancelOutcome> {
      const cancelled = await db
        .update(botCommands)
        .set({ status: 'cancelled', finishedAt: dbNow })
        .where(and(eq(botCommands.id, id), eq(botCommands.sessionId, sessionId), isPending))
        .returning({ id: botCommands.id })
      if (cancelled.length > 0) return 'cancelled'
      const [row] = await db.select({ sessionId: botCommands.sessionId }).from(botCommands).where(eq(botCommands.id, id))
      if (!row) return 'not_found'
      return row.sessionId === sessionId ? 'not_pending' : 'other_session'
    },

    async listRecent(sessionId: string, limit = 20): Promise<CommandRow[]> {
      return db
        .select()
        .from(botCommands)
        .where(eq(botCommands.sessionId, sessionId))
        .orderBy(desc(botCommands.createdAt), desc(botCommands.id))
        .limit(limit)
    },
  }
}

export type CommandsRepo = ReturnType<typeof createCommandsRepo>
