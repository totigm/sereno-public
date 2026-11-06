import { and, count, eq, isNull } from 'drizzle-orm'
import { positions, type Db } from '@sereno/db'

/** Las abiertas de la sesión, de verdad y sombra: las mismas que impiden archivarla (`archiveReal`). */
export async function countOpenPositions(db: Db, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(positions)
    .where(and(eq(positions.sessionId, sessionId), isNull(positions.closedAt)))
  return row?.n ?? 0
}
