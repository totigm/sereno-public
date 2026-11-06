import { bigint, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'
import type { Settings } from '@sereno/shared'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// Una fila por sesión: la clave es la sesión. Optimistic locking con
// `UPDATE … WHERE session_id = $id AND version = $expected` (spec §10).
export const settings = pgTable('settings', {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  config: jsonb().$type<Settings>().notNull(),
  version: integer().notNull().default(1),
  updatedAt: timestamptz().notNull().defaultNow(),
  // Email de quien guardó; null cuando lo escribió el bot (pausa automática).
  updatedBy: text(),
})

export const settingsHistory = pgTable(
  'settings_history',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    config: jsonb().$type<Settings>().notNull(),
    changedBy: text(),
    changedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [unique('settings_history_session_id_version_key').on(t.sessionId, t.version)],
)
