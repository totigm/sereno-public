import { bigint, doublePrecision, index, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns'
import { equitySnapshotKind } from './enums'
import { sessions } from './sessions'

// Curva de capital: una fila por minuto (retención 90 días) y una por evento
// (para siempre). El índice sirve la última fila y los rangos del gráfico.
export const equitySnapshots = pgTable(
  'equity_snapshots',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: timestamptz().notNull(),
    saldo: doublePrecision().notNull(),
    equity: doublePrecision().notNull(),
    margenEnUso: doublePrecision().notNull(),
    protegido: doublePrecision().notNull(),
    capitalBase: doublePrecision().notNull(),
    capitalOperable: doublePrecision().notNull(),
    shadowEquity: doublePrecision(),
    kind: equitySnapshotKind().notNull(),
  },
  // `DESC NULLS FIRST` = el orden de un `ORDER BY at DESC` común (ver decisions.ts).
  (t) => [index('equity_snapshots_session_id_at_idx').on(t.sessionId, t.at.desc().nullsFirst())],
)
