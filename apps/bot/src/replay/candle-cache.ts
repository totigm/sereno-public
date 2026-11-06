// Velas de una serie para el replay (spec §9): se guardan en `candles` (compartida con el
// vivo) y se reutilizan; de Binance sólo se pide lo que falta. Cada pedido pasa por el
// presupuesto del proceso además del limitador del cliente.

import type { Candle, PriceType, Timeframe } from '@sereno/core'
import type { CandlesRepo } from '@sereno/db'
import { MAX_KLINES_LIMIT, klinesWeight, type BinanceRest } from '../binance/rest'
import { INTERVAL_MS, type KlineQuery } from '../binance/types'
import type { CallBudget } from '../jobs/budget'

export interface SeriesKey {
  symbol: string
  timeframe: Timeframe
  priceType: PriceType
}

export interface CandleSource {
  rest: Pick<BinanceRest, 'klines' | 'markPriceKlines'>
  repos: { candles: Pick<CandlesRepo, 'range' | 'upsertMany'> }
  budget: CallBudget
}

export interface LoadedSeries {
  candles: Candle[]
  reused: number
  downloaded: number
}

// Las velas cerradas con apertura en [from, to), en orden. Una vela guardada abierta (el
// vivo escribe la vela en curso) no cuenta: se vuelve a pedir.
export async function loadSeries(source: CandleSource, key: SeriesKey, from: number, to: number): Promise<LoadedSeries> {
  const ms = INTERVAL_MS[key.timeframe]
  const start = Math.ceil(from / ms) * ms
  const stored = (await source.repos.candles.range(key.symbol, key.timeframe, key.priceType, start, to)).filter((c) => c.closed)
  const have = new Set(stored.map((c) => c.openTime))
  const fetched: Candle[] = []
  for (const run of missingRuns(start, to, ms, have)) fetched.push(...(await fetchRun(source, key, run)))
  if (fetched.length > 0) await source.repos.candles.upsertMany(key, fetched)
  const candles = [...stored, ...fetched].sort((a, b) => a.openTime - b.openTime)
  return { candles, reused: stored.length, downloaded: fetched.length }
}

interface Run {
  first: number
  last: number
}

// Tramos de aperturas consecutivas que faltan.
function missingRuns(start: number, to: number, ms: number, have: ReadonlySet<number>): Run[] {
  const runs: Run[] = []
  let current: Run | null = null
  for (let open = start; open < to; open += ms) {
    if (have.has(open)) {
      current = null
    } else if (current) {
      current.last = open
    } else {
      current = { first: open, last: open }
      runs.push(current)
    }
  }
  return runs
}

// Un tramo en páginas de hasta 1.500. Una página corta es un hueco de Binance (antes del
// listado o un mantenimiento): se sigue con la siguiente, no se insiste.
async function fetchRun({ rest, budget }: CandleSource, { symbol, timeframe, priceType }: SeriesKey, { first, last }: Run): Promise<Candle[]> {
  const ms = INTERVAL_MS[timeframe]
  const fetchPage = (query: KlineQuery): Promise<Candle[]> =>
    priceType === 'last' ? rest.klines(symbol, timeframe, query) : rest.markPriceKlines(symbol, timeframe, query)
  const out: Candle[] = []
  for (let pageStart = first; pageStart <= last; ) {
    const pageEnd = Math.min(last, pageStart + (MAX_KLINES_LIMIT - 1) * ms)
    const limit = (pageEnd - pageStart) / ms + 1
    await budget.acquire('weight', klinesWeight(limit))
    // `endTime` filtra por apertura: la última vela pedida entra.
    const page = await fetchPage({ startTime: pageStart, endTime: pageEnd, limit })
    out.push(...page.filter((c) => c.closed && c.openTime >= pageStart && c.openTime <= pageEnd))
    pageStart = pageEnd + ms
  }
  return out
}
