import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { universeDays, type UniverseDayEntry, type UniverseExcluded } from '../schema'
import { chunks, excluded as incoming } from './sql-helpers'

// El universo de un día UTC (`YYYY-MM-DD`) de una sesión: las monedas que entraron y
// las que quedaron afuera por un filtro, con su motivo (spec §5.1).
export interface UniverseDay {
  day: string
  symbols: UniverseDayEntry[]
  excluded: UniverseExcluded
}

const COLUMNS = { day: universeDays.day, symbols: universeDays.symbols, excluded: universeDays.excluded }

export function createUniverseDaysRepo(db: Db) {
  return {
    // Un snapshot por sesión y día; recalcular el día lo reemplaza entero.
    async upsertDay(sessionId: string, { day, symbols, excluded }: UniverseDay): Promise<void> {
      await db
        .insert(universeDays)
        .values({ sessionId, day, symbols, excluded })
        .onConflictDoUpdate({ target: [universeDays.sessionId, universeDays.day], set: { symbols, excluded } })
    },

    // Todos los días de un replay en pocas sentencias; los que ya estaban se reemplazan.
    async upsertDays(sessionId: string, days: readonly UniverseDay[]): Promise<void> {
      for (const part of chunks(days, 500)) {
        await db
          .insert(universeDays)
          .values(part.map(({ day, symbols, excluded }) => ({ sessionId, day, symbols, excluded })))
          .onConflictDoUpdate({
            target: [universeDays.sessionId, universeDays.day],
            set: { symbols: incoming(universeDays.symbols), excluded: incoming(universeDays.excluded) },
          })
      }
    },

    async forDay(sessionId: string, day: string): Promise<UniverseDay | null> {
      const [row] = await db
        .select(COLUMNS)
        .from(universeDays)
        .where(and(eq(universeDays.sessionId, sessionId), eq(universeDays.day, day)))
      return row ?? null
    },

    async latest(sessionId: string): Promise<UniverseDay | null> {
      const [row] = await db
        .select(COLUMNS)
        .from(universeDays)
        .where(eq(universeDays.sessionId, sessionId))
        .orderBy(desc(universeDays.day))
        .limit(1)
      return row ?? null
    },
  }
}

export type UniverseDaysRepo = ReturnType<typeof createUniverseDaysRepo>
