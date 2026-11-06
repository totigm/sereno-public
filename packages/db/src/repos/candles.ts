import { and, asc, eq, gte, lt } from 'drizzle-orm'
import type { Candle, PriceType, Timeframe } from '@sereno/core'
import type { Db } from '../client'
import { candles } from '../schema'
import { chunks, excluded, lastBy } from './sql-helpers'

type CandleRow = typeof candles.$inferSelect

export interface CandleKey {
  symbol: string
  timeframe: Timeframe
  priceType: PriceType
}

// Una vela abierta se reescribe hasta que cierra: todo menos la clave se actualiza.
const SET_ON_CONFLICT = Object.fromEntries(
  (['closeTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'closed'] as const).map((k) => [
    k,
    excluded(candles[k]),
  ]),
)

function toCandle(r: CandleRow): Candle {
  return {
    openTime: r.openTime.getTime(),
    closeTime: r.closeTime.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quoteVolume,
    closed: r.closed,
  }
}

// Velas compartidas entre sesiones (spec §9): el vivo las calienta y los
// replays las reutilizan. Única por (symbol, timeframe, priceType, openTime).
export function createCandlesRepo(db: Db) {
  return {
    async upsertMany(key: CandleKey, items: readonly Candle[]): Promise<void> {
      // 12 columnas por fila. Una vela abierta puede venir varias veces en el lote.
      for (const part of chunks(lastBy(items, (c) => String(c.openTime)), 2000)) {
        await db
          .insert(candles)
          .values(part.map((c) => ({ ...key, ...c, openTime: new Date(c.openTime), closeTime: new Date(c.closeTime) })))
          .onConflictDoUpdate({
            target: [candles.symbol, candles.timeframe, candles.priceType, candles.openTime],
            set: SET_ON_CONFLICT,
          })
      }
    },

    // Velas con `openTime` en [from, to), en orden. La causalidad (closeTime ≤ t)
    // la aplica quien arma la vista de mercado.
    async range(symbol: string, timeframe: Timeframe, priceType: PriceType, from: number, to: number): Promise<Candle[]> {
      const rows = await db
        .select()
        .from(candles)
        .where(
          and(
            eq(candles.symbol, symbol),
            eq(candles.timeframe, timeframe),
            eq(candles.priceType, priceType),
            gte(candles.openTime, new Date(from)),
            lt(candles.openTime, new Date(to)),
          ),
        )
        .orderBy(asc(candles.openTime))
      return rows.map(toCandle)
    },
  }
}

export type CandlesRepo = ReturnType<typeof createCandlesRepo>
