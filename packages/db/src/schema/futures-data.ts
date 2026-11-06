import { doublePrecision, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns'

// Serie de datos de futuros por símbolo (funding, interés abierto, ratios).
// Los valores que Binance no devuelve quedan en null; el motor los trata como
// señal faltante (spec §5.3).
export const futuresData = pgTable(
  'futures_data',
  {
    symbol: text().notNull(),
    at: timestamptz().notNull(),
    fundingRate: doublePrecision(),
    nextFundingTime: timestamptz(),
    openInterest: doublePrecision(),
    longShortRatio: doublePrecision(),
    takerRatio: doublePrecision(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.at] })],
)
