import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns'
import { sessions } from './sessions'

// Estados que muestra la baldosa de cada moneda (spec §11.1).
export type MarketSymbolState = 'ready' | 'in_position' | 'degraded' | 'cooldown' | 'penalized'

export interface MarketSymbolView {
  symbol: string
  markPrice: number
  change24h: number | null
  sPrime: number | null
  // Inclinación de −1 (short) a +1 (long) para la barra de la baldosa.
  lean: number
  state: MarketSymbolState
  // ISO 8601: fin del enfriamiento o de la penitencia, según el estado.
  stateUntil?: string
  // ISO 8601: desde cuándo no llegan datos (sólo `degraded`).
  staleSince?: string
}

// Una sola fila viva por sesión, reescrita cada ciclo con
// `INSERT … ON CONFLICT (session_id) DO UPDATE`. El fillfactor 50 (migración
// 0001) deja lugar en la página para que esas actualizaciones sean HOT.
export const marketSnapshot = pgTable('market_snapshot', {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  updatedAt: timestamptz().notNull().defaultNow(),
  version: integer().notNull().default(0),
  symbols: jsonb().$type<MarketSymbolView[]>().notNull(),
})
