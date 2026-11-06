import { asc, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { symbols } from '../schema'
import { chunks, dbNow, excluded, lastBy } from './sql-helpers'

type SymbolRow = typeof symbols.$inferSelect

// Un contrato como lo guarda la base, con los instantes en ms como el resto del motor.
export type SymbolRecord = Omit<SymbolRow, 'onboardDate' | 'updatedAt'> & { onboardDate: number; updatedAt: number }

// Lo que sale de `exchangeInfo` + `fundingInfo` + la tabla de mmr. El spread
// observado no viaja acá: lo mide el bot aparte y un refresco no lo borra.
export type SymbolUpsert = Omit<SymbolRecord, 'observedSpread' | 'updatedAt'>

const REFRESHED = [
  'baseAsset',
  'quoteAsset',
  'contractType',
  'status',
  'minNotional',
  'minQty',
  'stepSize',
  'tickSize',
  'quantityPrecision',
  'underlyingType',
  'underlyingSubType',
  'onboardDate',
  'fundingIntervalHours',
  'liquidationFee',
  'mmr',
  'updatedAt',
] as const satisfies readonly (keyof SymbolRow)[]

const SET_ON_REFRESH = Object.fromEntries(REFRESHED.map((k) => [k, excluded(symbols[k])]))

function toRecord(r: SymbolRow): SymbolRecord {
  return { ...r, onboardDate: r.onboardDate.getTime(), updatedAt: r.updatedAt.getTime() }
}

export function createSymbolsRepo(db: Db) {
  return {
    async upsertMany(items: readonly SymbolUpsert[]): Promise<void> {
      // 18 columnas por fila: 1.000 filas quedan lejos del tope de parámetros.
      for (const part of chunks(lastBy(items, (s) => s.symbol), 1000)) {
        await db
          .insert(symbols)
          .values(part.map((s) => ({ ...s, onboardDate: new Date(s.onboardDate), updatedAt: dbNow })))
          .onConflictDoUpdate({ target: symbols.symbol, set: SET_ON_REFRESH })
      }
    },

    // Medio spread relativo medido del libro (spec §6). Devuelve si el símbolo existía.
    async setObservedSpread(symbol: string, halfSpread: number): Promise<boolean> {
      const updated = await db
        .update(symbols)
        .set({ observedSpread: halfSpread, updatedAt: dbNow })
        .where(eq(symbols.symbol, symbol))
        .returning({ symbol: symbols.symbol })
      return updated.length > 0
    },

    async all(): Promise<SymbolRecord[]> {
      const rows = await db.select().from(symbols).orderBy(asc(symbols.symbol))
      return rows.map(toRecord)
    },
  }
}

export type SymbolsRepo = ReturnType<typeof createSymbolsRepo>
