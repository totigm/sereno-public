import { and, asc, desc, eq, gt, lt } from 'drizzle-orm'
import { SettingsSchema, type Settings } from '@sereno/shared'
import type { Db } from '../client'
import { settings, settingsHistory } from '../schema'
import { dbNow } from './sql-helpers'

export type SettingsRow = typeof settings.$inferSelect
export type SettingsHistoryRow = typeof settingsHistory.$inferSelect

// Un parche reemplaza grupos enteros (`risk`, `exits`, `pause`…): así "deshacer"
// es escribir el grupo anterior tal cual, y un mapa como `mmrBySymbol` puede
// perder claves, cosa que una mezcla profunda no permitiría.
export type SettingsPatch = Partial<Settings>

// `version` es la vigente después del intento: la nueva si se aplicó, la que
// encontró si no (o null si la sesión no tiene configuración).
export interface SettingsUpdateResult {
  ok: boolean
  version: number | null
}

export interface ChangedBy {
  // Email de quien guardó; sin él, lo escribió el bot (pausa automática).
  by?: string | null
}

export function createSettingsRepo(db: Db) {
  return {
    async get(sessionId: string): Promise<SettingsRow | null> {
      const [row] = await db.select().from(settings).where(eq(settings.sessionId, sessionId))
      return row ?? null
    },

    // Versión 1 de una sesión nueva, con su primera fila de historia.
    async create(sessionId: string, config: Settings, { by = null }: ChangedBy = {}): Promise<void> {
      const valid = SettingsSchema.parse(config)
      await db.transaction(async (tx) => {
        await tx.insert(settings).values({ sessionId, config: valid, version: 1, updatedAt: dbNow, updatedBy: by })
        await tx.insert(settingsHistory).values({ sessionId, version: 1, config: valid, changedBy: by, changedAt: dbNow })
      })
    },

    // Optimistic locking (spec §10): sólo escribe si la versión sigue siendo la
    // que vio quien edita. Un parche que deja la configuración inválida lanza.
    async update(
      sessionId: string,
      patch: SettingsPatch,
      expectedVersion: number,
      { by = null }: ChangedBy = {},
    ): Promise<SettingsUpdateResult> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(settings).where(eq(settings.sessionId, sessionId))
        if (!current) return { ok: false, version: null }
        if (current.version !== expectedVersion) return { ok: false, version: current.version }
        const config = SettingsSchema.parse({ ...current.config, ...patch })
        const version = expectedVersion + 1
        // El `WHERE version` cubre la carrera entre la lectura y esta escritura:
        // si otro guardó en el medio, no actualiza nada.
        const [written] = await tx
          .update(settings)
          .set({ config, version, updatedAt: dbNow, updatedBy: by })
          .where(and(eq(settings.sessionId, sessionId), eq(settings.version, expectedVersion)))
          .returning({ version: settings.version })
        if (!written) {
          const [now] = await tx.select({ version: settings.version }).from(settings).where(eq(settings.sessionId, sessionId))
          return { ok: false, version: now?.version ?? null }
        }
        await tx.insert(settingsHistory).values({ sessionId, version, config, changedBy: by, changedAt: dbNow })
        return { ok: true, version }
      })
    },

    async history(sessionId: string, limit = 50): Promise<SettingsHistoryRow[]> {
      return db
        .select()
        .from(settingsHistory)
        .where(eq(settingsHistory.sessionId, sessionId))
        .orderBy(desc(settingsHistory.version))
        .limit(limit)
    },

    // Las versiones estrictamente entre `after` y `before`, de la más vieja a la más nueva.
    // Por rango explícito y no "las últimas N": una versión guardada después de `before`
    // no corre la ventana.
    async historyBetween(sessionId: string, after: number, before: number): Promise<SettingsHistoryRow[]> {
      return db
        .select()
        .from(settingsHistory)
        .where(and(eq(settingsHistory.sessionId, sessionId), gt(settingsHistory.version, after), lt(settingsHistory.version, before)))
        .orderBy(asc(settingsHistory.version))
    },
  }
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>
