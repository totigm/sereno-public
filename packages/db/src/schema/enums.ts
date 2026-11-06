import { pgEnum } from 'drizzle-orm/pg-core'
import {
  BOT_PHASES,
  COMMAND_KINDS,
  COMMAND_STATUSES,
  EQUITY_SNAPSHOT_KINDS,
  POSITION_EVENT_KINDS,
  REAL_STATUSES,
  SESSION_KINDS,
  SESSION_STATUSES,
} from '@sereno/shared'

// Los enums de Postgres salen de las listas `as const` de @sereno/shared: una sola
// fuente para el tipo TS, el zod del dashboard y la restricción en la base. Lo que
// en @sereno/core existe sólo como tipo (Side, Timeframe, CloseReason…) va como
// `text` tipado, para no duplicar listas ni frenar al motor con un ALTER TYPE.
export const sessionKind = pgEnum('session_kind', SESSION_KINDS)
export const sessionStatus = pgEnum('session_status', SESSION_STATUSES)
export const botPhase = pgEnum('bot_phase', BOT_PHASES)
export const commandKind = pgEnum('command_kind', COMMAND_KINDS)
export const commandStatus = pgEnum('command_status', COMMAND_STATUSES)
export const equitySnapshotKind = pgEnum('equity_snapshot_kind', EQUITY_SNAPSHOT_KINDS)
export const positionEventKind = pgEnum('position_event_kind', POSITION_EVENT_KINDS)
export const realStatus = pgEnum('real_status', REAL_STATUSES)
