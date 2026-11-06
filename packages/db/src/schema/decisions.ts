import { bigint, doublePrecision, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { BlockReason, SignalId, SignalResult } from '@sereno/core'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// Qué hizo el motor con cada vela: entrar, esperar o `blocked:<filtro>` (spec §10).
export type DecisionActionLabel = 'enter_long' | 'enter_short' | 'wait' | `blocked:${BlockReason}`
// La sombra informa sólo la clase de acción (`Decision['shadow']['action']`), sin
// motivo de bloqueo; la dirección de una entrada sale del signo de su S'.
export type ShadowActionLabel = 'enter_long' | 'enter_short' | 'wait' | 'blocked'

export const decisions = pgTable(
  'decisions',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    symbol: text().notNull(),
    candleCloseTime: timestamptz().notNull(),
    s: doublePrecision().notNull(),
    sPrime: doublePrecision().notNull(),
    signals: jsonb().$type<SignalResult[]>().notNull(),
    missingSignals: jsonb().$type<SignalId[]>().notNull(),
    action: text().$type<DecisionActionLabel>().notNull(),
    blockedBy: text().$type<BlockReason>(),
    // Retornos a 4 h y 24 h: se rellenan después, cuando esas velas cierran.
    forwardReturn4h: doublePrecision('forward_return_4h'),
    forwardReturn24h: doublePrecision('forward_return_24h'),
    shadowAction: text().$type<ShadowActionLabel>(),
  },
  // `DESC NULLS FIRST` es el orden de un `ORDER BY … DESC` común: así el índice
  // sirve esa consulta tal cual (drizzle emite NULLS LAST si no se lo pide).
  (t) => [index('decisions_session_id_candle_close_time_idx').on(t.sessionId, t.candleCloseTime.desc().nullsFirst())],
)
