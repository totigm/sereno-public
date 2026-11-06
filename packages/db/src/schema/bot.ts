import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { RealGate } from '@sereno/shared'
import { timestamptz } from './columns'
import { botPhase } from './enums'
import { sessions } from './sessions'

// Cortes y pausas activos, para que el dashboard los diga sin recalcular.
export interface BotFlags {
  btcVolExtreme: boolean
  dailyLossHit: boolean
  drawdownPause: boolean
  streakPause: boolean
  learningFrozen: boolean
}

export interface BotError {
  // ISO 8601.
  at: string
  message: string
  context?: string
}

// Latido del proceso: una fila por sesión que el bot reescribe cada 10 s.
export const botStatus = pgTable('bot_status', {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  instanceId: text().notNull(),
  lastHeartbeat: timestamptz().notNull(),
  phase: botPhase().notNull(),
  // Monedas ya calientes durante `warming` ("Calentando · 18 de 30 monedas").
  warmProgress: integer().notNull().default(0),
  universeSize: integer().notNull().default(0),
  lastCycleAt: timestamptz(),
  settingsVersionApplied: integer(),
  degradedSymbols: text().array().notNull(),
  flags: jsonb().$type<BotFlags>().notNull(),
  recentErrors: jsonb().$type<BotError[]>().notNull(),
  botVersion: text().notNull(),
  // Qué puede hacer la sesión con plata real y qué le falta; null en papel.
  real: jsonb().$type<RealGate>(),
})

// Quién tiene derecho a operar la sesión. Se renueva con el latido y sólo opera
// el proceso cuyo `instance_id` figura acá (spec §10, §12).
export const botLease = pgTable('bot_lease', {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  instanceId: text().notNull(),
  leaseUntil: timestamptz().notNull(),
})
