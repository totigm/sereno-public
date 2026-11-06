import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import type { Command } from '@sereno/shared'
import { timestamptz } from './columns'
import { commandKind, commandStatus } from './enums'
import { sessions } from './sessions'

// Lo que el bot deja al terminar un comando, bueno o malo.
export interface CommandResult {
  ok: boolean
  message: string
  data?: unknown
}

// Cola de comandos del dashboard al bot. El id lo genera el cliente y es la
// clave de idempotencia (`ON CONFLICT DO NOTHING`); el claim es atómico con
// `FOR UPDATE SKIP LOCKED` sobre el índice (session_id, status, created_at).
export const botCommands = pgTable(
  'bot_commands',
  {
    id: uuid().primaryKey(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: commandKind().notNull(),
    // Vacío por defecto: los comandos sin parámetros (close_all, reset_learning…)
    // se encolan sin payload y la fila igual queda con `{}` (nunca null).
    payload: jsonb().$type<Command['payload']>().notNull().default({}),
    status: commandStatus().notNull().default('pending'),
    createdAt: timestamptz().notNull().defaultNow(),
    // 60 s para los sensibles al precio; null para el resto (spec §10).
    expiresAt: timestamptz(),
    claimedAt: timestamptz(),
    claimedBy: text(),
    finishedAt: timestamptz(),
    result: jsonb().$type<CommandResult>(),
    requestedBy: text().notNull(),
  },
  (t) => [index('bot_commands_session_id_status_created_at_idx').on(t.sessionId, t.status, t.createdAt)],
)
