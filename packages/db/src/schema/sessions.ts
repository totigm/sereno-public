import { sql } from 'drizzle-orm'
import { doublePrecision, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { BinanceEnv, Command, LearningOrigin, RealOffReason, Settings } from '@sereno/shared'
import { timestamptz } from './columns'
import { realStatus, sessionKind, sessionStatus } from './enums'
import type { ReplayReport } from './replay-report'

// Parámetros con los que se pidió un replay: los mismos que valida `CommandSchema`.
export type ReplayParams = Extract<Command, { kind: 'run_replay' }>['payload']

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    kind: sessionKind().notNull(),
    name: text().notNull(),
    status: sessionStatus().notNull(),
    capitalInicial: doublePrecision().notNull(),
    baseBlindaje: doublePrecision().notNull(),
    protegido: doublePrecision().notNull().default(0),
    // Incluye los valores por defecto: con ellos corre la sombra (spec §8).
    settingsSnapshot: jsonb().$type<Settings>().notNull(),
    learningOrigin: text().$type<LearningOrigin>().notNull(),
    startedAt: timestamptz().notNull(),
    endedAt: timestamptz(),
    // Sólo para replays: avance 0..1 y mensaje de estado para el dashboard.
    progreso: doublePrecision(),
    mensaje: text(),
    replayParams: jsonb().$type<ReplayParams>(),
    // El reporte de un replay terminado (spec §9); null mientras corre o si no terminó bien.
    // Pesa decenas de KB: los listados de sesiones no lo traen (ver `repos/sessions.ts`).
    report: jsonb().$type<ReplayReport>(),
    // Sólo la sesión con plata real (`kind = 'live'`); null en las demás. El entorno
    // queda fijo al crearla: una sesión de testnet nunca opera en mainnet ni al revés.
    binanceEnv: text().$type<BinanceEnv>(),
    realStatus: realStatus(),
    realOffReason: text().$type<RealOffReason>(),
    realChangedAt: timestamptz(),
  },
  // Una activa por tipo: la simulación en papel y la de plata real conviven, pero
  // nunca hay dos del mismo (los replays nunca están `active`, usan sus propios estados).
  (t) => [uniqueIndex('sessions_single_active_per_kind_idx').on(t.kind).where(sql`${t.status} = 'active'`)],
)
