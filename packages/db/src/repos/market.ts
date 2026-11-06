import { eq, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { marketSnapshot, type MarketSymbolView } from '../schema'
import { dbNow, excluded } from './sql-helpers'

export type MarketSnapshotRow = typeof marketSnapshot.$inferSelect

export function createMarketRepo(db: Db) {
  return {
    // Un solo UPSERT por ciclo sobre la fila viva de la sesión (spec §10). La
    // versión sube en cada escritura: es lo que mira `/api/live?since=`.
    async upsert(sessionId: string, symbols: MarketSymbolView[]): Promise<number> {
      const [row] = await db
        .insert(marketSnapshot)
        .values({ sessionId, symbols, version: 1, updatedAt: dbNow })
        .onConflictDoUpdate({
          target: marketSnapshot.sessionId,
          set: {
            symbols: excluded(marketSnapshot.symbols),
            updatedAt: excluded(marketSnapshot.updatedAt),
            version: sql`${marketSnapshot.version} + 1`,
          },
        })
        .returning({ version: marketSnapshot.version })
      if (!row) throw new Error(`No se pudo escribir el snapshot de mercado de ${sessionId}`)
      return row.version
    },

    async get(sessionId: string): Promise<MarketSnapshotRow | null> {
      const [row] = await db.select().from(marketSnapshot).where(eq(marketSnapshot.sessionId, sessionId))
      return row ?? null
    },
  }
}

export type MarketRepo = ReturnType<typeof createMarketRepo>
