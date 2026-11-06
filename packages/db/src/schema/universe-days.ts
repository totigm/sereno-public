import { date, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type { ContractMeta } from '@sereno/core'
import type { UniverseExclusionReason } from '@sereno/core/src/universe/select-universe'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// Una entrada por moneda del universo del día: ranking por volumen de 24 h y el
// snapshot de filtros del contrato ese día (spec §5.1).
export interface UniverseDayEntry {
  symbol: string
  rank: number
  quoteVolume24h: number
  pinned: boolean
  filters: ContractMeta['filters']
  /** Abierta que hoy no pasa un filtro: sigue en el universo sólo por la posición, con su motivo. */
  keptOpen?: UniverseExclusionReason
  /** Abierta cuyo contrato ya no está en exchangeInfo: sigue hasta cerrarla como `delisted`. */
  delisted?: true
}

// Una moneda que quedó afuera del universo ese día por un filtro, con su motivo.
export interface UniverseExcludedEntry {
  reason: UniverseExclusionReason
  /** El dato del contrato que no pasó el filtro (tipo, estado, cotización, día de listado…). */
  detail?: string
  /** Estaba fijada y aun así no entró. */
  pinned?: true
}

export type UniverseExcluded = Record<string, UniverseExcludedEntry>

export const universeDays = pgTable(
  'universe_days',
  {
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    symbols: jsonb().$type<UniverseDayEntry[]>().notNull(),
    excluded: jsonb().$type<UniverseExcluded>().notNull().default({}),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.day] })],
)
