import { and, desc, eq, sql } from 'drizzle-orm'
import type { LearningState, SignalId } from '@sereno/core'
import type { Db } from '../client'
import { learningLog, learningState } from '../schema'
import { asList, chunks, dbNow, excluded } from './sql-helpers'

type LearningStateRow = typeof learningState.$inferSelect
type LearningLogRow = typeof learningLog.$inferSelect

// La forma de `LearningChange` de core (que todavía no sale por su índice): una
// entrada del diario del aprendizaje con su tamaño muestral y el antes y después.
export interface LearningLogEntry {
  at: number
  kind: string
  symbol: string | null
  signal: SignalId | null
  message: string
  sampleSize: number
  before: unknown
  after: unknown
}

export type LearningLogRecord = LearningLogEntry & { id: number; sessionId: string }

export interface LogPage {
  limit?: number
  cursor?: { at: number; id: number }
}

const STATE_COLUMNS = [
  'weightsGlobal',
  'weightsBySymbol',
  'weeklyDelta',
  'weekStart',
  'confidenceBySymbol',
  'tradesBySymbol',
  'penalties',
  'params',
  'frozen',
  'closedTrades',
  'version',
  'updatedAt',
] as const satisfies readonly (keyof LearningStateRow)[]

const SET_ON_SAVE = Object.fromEntries(STATE_COLUMNS.map((k) => [k, excluded(learningState[k])]))

function toState(r: LearningStateRow): LearningState {
  return {
    weightsGlobal: r.weightsGlobal,
    weightsBySymbol: r.weightsBySymbol,
    weeklyDelta: r.weeklyDelta,
    weekStart: r.weekStart.getTime(),
    confidenceBySymbol: r.confidenceBySymbol,
    tradesBySymbol: r.tradesBySymbol,
    penalties: r.penalties,
    params: r.params,
    frozen: r.frozen,
    closedTrades: r.closedTrades,
    version: r.version,
  }
}

function toLogRecord(r: LearningLogRow): LearningLogRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    at: r.at.getTime(),
    kind: r.kind,
    symbol: r.symbol,
    signal: r.signal,
    message: r.message,
    sampleSize: r.sampleSize,
    before: r.before ?? null,
    after: r.after ?? null,
  }
}

export function createLearningRepo(db: Db) {
  return {
    // null mientras la sesión no aprendió nada: el bot arranca del estado inicial.
    async get(sessionId: string): Promise<LearningState | null> {
      const [row] = await db.select().from(learningState).where(eq(learningState.sessionId, sessionId))
      return row ? toState(row) : null
    },

    async save(sessionId: string, state: LearningState): Promise<void> {
      await db
        .insert(learningState)
        .values({ sessionId, ...state, weekStart: new Date(state.weekStart), updatedAt: dbNow })
        .onConflictDoUpdate({ target: learningState.sessionId, set: SET_ON_SAVE })
    },

    async appendLog(sessionId: string, entries: LearningLogEntry | readonly LearningLogEntry[]): Promise<void> {
      for (const part of chunks(asList(entries), 1000)) {
        await db.insert(learningLog).values(part.map((e) => ({ ...e, sessionId, at: new Date(e.at) })))
      }
    },

    // El diario, lo más nuevo primero. Para la página siguiente se pasa la última
    // entrada recibida: un lote de cambios comparte `at`, por eso el cursor
    // lleva también el id y ninguna entrada queda entre dos páginas.
    async listLog(sessionId: string, { limit = 50, cursor }: LogPage = {}): Promise<LearningLogRecord[]> {
      const rows = await db
        .select()
        .from(learningLog)
        .where(
          and(
            eq(learningLog.sessionId, sessionId),
            cursor === undefined ? undefined : sql`(${learningLog.at}, ${learningLog.id}) < (${new Date(cursor.at).toISOString()}::timestamptz, ${cursor.id}::bigint)`,
          ),
        )
        .orderBy(desc(learningLog.at), desc(learningLog.id))
        .limit(limit)
      return rows.map(toLogRecord)
    },
  }
}

export type LearningRepo = ReturnType<typeof createLearningRepo>
