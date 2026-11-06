import { bigint, boolean, doublePrecision, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { BinanceEnv, RealCheck } from '@sereno/shared'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// Los chequeos de la cuenta de Binance que corre el bot (al arrancar y cada 5 min),
// una fila por entorno. El dashboard los lee para decir qué falta: nunca llama a Binance.
export const realReadiness = pgTable('real_readiness', {
  env: text().$type<BinanceEnv>().primaryKey(),
  checkedAt: timestamptz().notNull(),
  // `SERENO_REAL_TRADING=on` en el proceso que escribió la fila.
  enabled: boolean().notNull(),
  keysPresent: boolean().notNull(),
  checks: jsonb().$type<RealCheck[]>().notNull(),
  // USDT disponible en la billetera de futuros; null si no se pudo leer.
  walletAvailable: doublePrecision(),
  instanceId: text().notNull(),
})

export type RealEventKind =
  | 'rejected'
  | 'foreign_position'
  | 'mismatch'
  | 'reconciled'
  | 'adopted'
  | 'unprotected'
  | 'loss_floor'
  | 'fatal'
  | 'off'
  | 'on'

// Lo que pasó entre la sesión real y Binance y el diario cuenta: rechazos, posiciones
// ajenas, diferencias de reconciliación, adopciones, apagados. Texto tipado y no enum:
// agregar un tipo no pide un ALTER TYPE.
export const realEvents = pgTable(
  'real_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: timestamptz().notNull(),
    kind: text().$type<RealEventKind>().notNull(),
    symbol: text(),
    phrase: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('real_events_session_id_at_idx').on(t.sessionId, t.at)],
)
