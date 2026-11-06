import { and, asc, eq, isNull } from 'drizzle-orm'
import { botStatus, createDirectDb, marketSnapshot, positions, sessions, settings, type DirectDb } from '@sereno/db'
import type { Settings } from '@sereno/shared'

// Lo que la prueba de humo lee y escribe directo en la base de desarrollo.

export function openDb(url: string): DirectDb {
  return createDirectDb(url, { max: 2 })
}

export async function closeDb(db: DirectDb): Promise<void> {
  await db.$client.end()
}

export async function activeSessionId(db: DirectDb): Promise<string> {
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.status, 'active'))
  if (!row) throw new Error('La base no tiene una simulación activa: ¿corrió el seed del escenario active?')
  return row.id
}

export interface OpenTrade {
  id: string
  symbol: string
}

/** La primera abierta de la sesión, por hora de entrada. */
export async function firstOpenTrade(db: DirectDb, sessionId: string): Promise<OpenTrade> {
  const [row] = await db
    .select({ id: positions.id, symbol: positions.symbol })
    .from(positions)
    .where(and(eq(positions.sessionId, sessionId), eq(positions.shadow, false), isNull(positions.closedAt)))
    .orderBy(asc(positions.openedAt))
    .limit(1)
  if (!row) throw new Error(`La sesión ${sessionId} no tiene abiertas.`)
  return row
}

export async function pauseOf(db: DirectDb, sessionId: string): Promise<Settings['pause']> {
  const [row] = await db.select({ config: settings.config }).from(settings).where(eq(settings.sessionId, sessionId))
  if (!row) throw new Error(`La sesión ${sessionId} no tiene ajustes.`)
  return row.config.pause
}

/**
 * Lo que hace el bot en vivo para el dashboard: el latido, los ajustes aplicados y el
 * snapshot de mercado, con la hora `at`. Sin latidos, a los 60 s de sembrar la base la
 * pantalla pasa a "sin conexión" y "Pausar" queda deshabilitado.
 */
export async function beat(db: DirectDb, sessionId: string, at: Date): Promise<void> {
  const [current] = await db.select({ version: settings.version }).from(settings).where(eq(settings.sessionId, sessionId))
  await db
    .update(botStatus)
    .set({ lastHeartbeat: at, settingsVersionApplied: current?.version ?? null })
    .where(eq(botStatus.sessionId, sessionId))
  await db.update(marketSnapshot).set({ updatedAt: at }).where(eq(marketSnapshot.sessionId, sessionId))
}
