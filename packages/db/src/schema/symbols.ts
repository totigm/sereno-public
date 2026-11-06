import { doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns'

// Metadatos de cada contrato tal como los devuelve `exchangeInfo`, más lo que el
// bot mide u obtiene aparte (mmr, spread observado). Es la fuente de `SymbolInfo`.
export const symbols = pgTable('symbols', {
  symbol: text().primaryKey(),
  baseAsset: text().notNull(),
  quoteAsset: text().notNull(),
  contractType: text().notNull(),
  status: text().notNull(),
  minNotional: doublePrecision().notNull(),
  minQty: doublePrecision().notNull(),
  stepSize: doublePrecision().notNull(),
  tickSize: doublePrecision().notNull(),
  quantityPrecision: integer().notNull(),
  underlyingType: text().notNull(),
  underlyingSubType: text().array().notNull(),
  onboardDate: timestamptz().notNull(),
  fundingIntervalHours: integer().notNull(),
  liquidationFee: doublePrecision().notNull(),
  mmr: doublePrecision().notNull(),
  // Medio spread relativo medido del libro; null hasta que el bot lo observe.
  observedSpread: doublePrecision(),
  updatedAt: timestamptz().notNull().defaultNow(),
})
