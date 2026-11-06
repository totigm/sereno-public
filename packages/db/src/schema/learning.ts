import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { LearningState, SignalId } from '@sereno/core'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// El estado de aprendizaje completo de una sesión (`LearningState` de core), una
// columna por campo para poder leer pesos o confianza sin traer todo. `weekStart`
// es el único instante: va como fecha, como el resto de la base.
export const learningState = pgTable('learning_state', {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  weightsGlobal: jsonb().$type<LearningState['weightsGlobal']>().notNull(),
  weightsBySymbol: jsonb().$type<LearningState['weightsBySymbol']>().notNull(),
  weeklyDelta: jsonb().$type<LearningState['weeklyDelta']>().notNull(),
  weekStart: timestamptz().notNull(),
  confidenceBySymbol: jsonb().$type<LearningState['confidenceBySymbol']>().notNull(),
  tradesBySymbol: jsonb().$type<LearningState['tradesBySymbol']>().notNull(),
  penalties: jsonb().$type<LearningState['penalties']>().notNull(),
  params: jsonb().$type<LearningState['params']>().notNull(),
  frozen: boolean().notNull().default(false),
  closedTrades: integer().notNull().default(0),
  version: integer().notNull().default(0),
  updatedAt: timestamptz().notNull().defaultNow(),
})

// Diario del aprendizaje: cada ajuste con su muestra y el antes y después, para
// que el dashboard explique qué cambió y por qué.
export const learningLog = pgTable(
  'learning_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: timestamptz().notNull(),
    kind: text().notNull(),
    // A qué moneda y a qué señal se acota el cambio; null cuando es global.
    symbol: text(),
    signal: text().$type<SignalId>(),
    message: text().notNull(),
    sampleSize: integer().notNull(),
    before: jsonb().$type<unknown>(),
    after: jsonb().$type<unknown>(),
  },
  // `DESC NULLS FIRST` = el orden de un `ORDER BY at DESC` común (ver decisions.ts).
  (t) => [index('learning_log_session_id_at_idx').on(t.sessionId, t.at.desc().nullsFirst())],
)
