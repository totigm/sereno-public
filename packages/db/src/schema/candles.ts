import { boolean, doublePrecision, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type { PriceType, Timeframe } from '@sereno/core'
import { timestamptz } from './columns'

// Velas de último precio y de precio de marca por símbolo y marco. La clave
// natural es la unicidad que pide la spec; no hace falta un id aparte.
export const candles = pgTable(
  'candles',
  {
    symbol: text().notNull(),
    timeframe: text().$type<Timeframe>().notNull(),
    priceType: text().$type<PriceType>().notNull(),
    openTime: timestamptz().notNull(),
    closeTime: timestamptz().notNull(),
    open: doublePrecision().notNull(),
    high: doublePrecision().notNull(),
    low: doublePrecision().notNull(),
    close: doublePrecision().notNull(),
    volume: doublePrecision().notNull(),
    quoteVolume: doublePrecision().notNull(),
    closed: boolean().notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.timeframe, t.priceType, t.openTime] })],
)
