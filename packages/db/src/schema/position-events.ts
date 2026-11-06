import { bigint, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns'
import { positionEventKind } from './enums'
import { positions } from './positions'

// Línea de tiempo de una posición: apertura, stops movidos, funding, cierres…
// El payload depende del evento (precios, montos, ids de orden), por eso es libre.
export const positionEvents = pgTable(
  'position_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    positionId: text()
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    kind: positionEventKind().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    at: timestamptz().notNull(),
  },
  (t) => [index('position_events_position_id_at_idx').on(t.positionId, t.at)],
)
