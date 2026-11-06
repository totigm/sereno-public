import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { futuresData } from '../schema'
import { asList, chunks, excluded, lastBy } from './sql-helpers'

type FuturesRow = typeof futuresData.$inferSelect

// Un punto de la serie de futuros de un símbolo, con instantes en ms. Lo que
// Binance no devolvió va en null y el motor lo trata como señal faltante.
export type FuturesPoint = Omit<FuturesRow, 'at' | 'nextFundingTime'> & { at: number; nextFundingTime: number | null }

const VALUES = ['fundingRate', 'nextFundingTime', 'openInterest', 'longShortRatio', 'takerRatio'] as const

// Dos fuentes pueden escribir el mismo instante (stream y REST): un null nuevo
// no borra un valor que ya estaba.
const MERGE_ON_CONFLICT = Object.fromEntries(
  VALUES.map((k) => [k, sql`coalesce(${excluded(futuresData[k])}, ${futuresData[k]})`]),
)

function toPoint(r: FuturesRow): FuturesPoint {
  return { ...r, at: r.at.getTime(), nextFundingTime: r.nextFundingTime === null ? null : r.nextFundingTime.getTime() }
}

export function createFuturesRepo(db: Db) {
  return {
    async insert(points: FuturesPoint | readonly FuturesPoint[]): Promise<void> {
      // Una sentencia no puede tocar dos veces la misma fila: gana el último del lote.
      const unique = lastBy(asList(points), (p) => `${p.symbol}@${p.at}`)
      for (const part of chunks(unique, 5000)) {
        await db
          .insert(futuresData)
          .values(
            part.map((p) => ({
              ...p,
              at: new Date(p.at),
              nextFundingTime: p.nextFundingTime === null ? null : new Date(p.nextFundingTime),
            })),
          )
          .onConflictDoUpdate({ target: [futuresData.symbol, futuresData.at], set: MERGE_ON_CONFLICT })
      }
    },

    // El último punto con `at ≤ asOf` (sin `asOf`, el último que haya).
    async latest(symbol: string, asOf?: number): Promise<FuturesPoint | null> {
      const [row] = await db
        .select()
        .from(futuresData)
        .where(and(eq(futuresData.symbol, symbol), asOf === undefined ? undefined : lte(futuresData.at, new Date(asOf))))
        .orderBy(desc(futuresData.at))
        .limit(1)
      return row ? toPoint(row) : null
    },

    // Puntos con `at` en [from, to), en orden.
    async range(symbol: string, from: number, to: number): Promise<FuturesPoint[]> {
      const rows = await db
        .select()
        .from(futuresData)
        .where(and(eq(futuresData.symbol, symbol), gte(futuresData.at, new Date(from)), lt(futuresData.at, new Date(to))))
        .orderBy(asc(futuresData.at))
      return rows.map(toPoint)
    },
  }
}

export type FuturesRepo = ReturnType<typeof createFuturesRepo>
