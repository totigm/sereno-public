import { boolean, doublePrecision, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { ClosedPosition, CloseReason, Position, Side, SignalId, SignalResult } from '@sereno/core'
import { timestamptz } from './columns'
import { sessions } from './sessions'

export const positions = pgTable(
  'positions',
  {
    id: text().primaryKey(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    symbol: text().notNull(),
    side: text().$type<Side>().notNull(),
    mode: text().$type<Position['mode']>().notNull(),
    leverage: integer().notNull(),
    margin: doublePrecision().notNull(),
    notional: doublePrecision().notNull(),
    qty: doublePrecision().notNull(),
    entryPrice: doublePrecision().notNull(),
    exitPrice: doublePrecision(),
    stopPrice: doublePrecision().notNull(),
    takeProfitPrice: doublePrecision(),
    liquidationPrice: doublePrecision().notNull(),
    trailingActive: boolean().notNull().default(false),
    bestPrice: doublePrecision().notNull(),
    riesgoReal: doublePrecision().notNull(),
    distanciaStop: doublePrecision().notNull(),
    thetaAtOpen: doublePrecision().notNull(),
    stopOrderId: text(),
    tpOrderId: text(),
    fees: doublePrecision().notNull().default(0),
    funding: doublePrecision().notNull().default(0),
    pnlGross: doublePrecision(),
    pnlNet: doublePrecision(),
    rMultiple: doublePrecision(),
    // Frase del diario al abrir; al cerrar, el motivo (enum) y su frase.
    openReason: text().notNull(),
    closeReason: text().$type<CloseReason>(),
    closePhrase: text(),
    signalsAtOpen: jsonb().$type<SignalResult[]>().notNull(),
    missingSignals: jsonb().$type<SignalId[]>().notNull(),
    costs: jsonb().$type<ClosedPosition['costs']>(),
    // Milisegundos entre el cierre de la vela y la orden (spec §5.2).
    latencyMs: integer(),
    openedAt: timestamptz().notNull(),
    closedAt: timestamptz(),
    shadow: boolean().notNull().default(false),
  },
  (t) => [index('positions_session_id_closed_at_idx').on(t.sessionId, t.closedAt)],
)
