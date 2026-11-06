// Calentamiento por REST antes de entrar al bucle (spec §5.2 y §12): para cada símbolo,
// las últimas velas cerradas de 15m, 1h y 4h de último precio y de precio de marca,
// guardadas en `candles` y devueltas para armar las series en memoria. Las llamadas
// pasan por un presupuesto propio (≤ 150 de peso 10 por minuto) además del limitador
// compartido del cliente. Todas las series cortan en el mismo instante, el del arranque.

import type { Candle, PriceType } from '@sereno/core'
import { BTC_15M_CANDLES_FOR_BASELINE } from '@sereno/core/src/market/btc-context'
import type { CandlesRepo } from '@sereno/db'
import { MAX_KLINES_LIMIT, klinesWeight, type BinanceRest } from '../binance/rest'
import { INTERVAL_MS, type KlineQuery } from '../binance/types'
import type { CallBudget } from '../jobs/budget'
import { errorMessage, isSymbolScoped, type SymbolFailure } from '../jobs/errors'
import { forEachLimit } from '../jobs/pool'
import type { Logger } from '../logger'

export const WARMUP_TIMEFRAMES = ['15m', '1h', '4h'] as const
export type WarmupTimeframe = (typeof WARMUP_TIMEFRAMES)[number]
const PRICE_TYPES = ['last', 'mark'] as const satisfies readonly PriceType[]

// El contexto de mercado sale de BTC: se calienta aunque no esté en el universo.
export const BTC_SYMBOL = 'BTCUSDT'
const DEFAULT_CONCURRENCY = 4

export interface WarmupDeps {
  rest: Pick<BinanceRest, 'klines' | 'markPriceKlines'>
  repos: { candles: Pick<CandlesRepo, 'upsertMany'> }
  now: () => number
  logger: Logger
  // Uno solo por proceso (`weightBudget(WARMUP_WEIGHT_PER_MINUTE)`), compartido por todos
  // los calentamientos: dos seguidos en el mismo minuto no suman más que el tope.
  budget: CallBudget
}

export interface WarmupOptions {
  candlesPerTf: number
  concurrency?: number
}

export interface WarmupProgress {
  done: number
  total: number
}

export type WarmedSymbol = Record<WarmupTimeframe, Record<PriceType, Candle[]>>

export interface WarmupResult {
  // Sólo los símbolos con todas sus series; los demás están en `failed`.
  candles: Record<string, WarmedSymbol>
  failed: SymbolFailure[]
}

interface SeriesTask {
  symbol: string
  timeframe: WarmupTimeframe
  priceType: PriceType
  count: number
  // Instante de corte común: la serie termina en la última vela cerrada antes de él.
  cutoff: number
}

export async function warmup(
  deps: WarmupDeps,
  symbols: readonly string[],
  { candlesPerTf, concurrency = DEFAULT_CONCURRENCY }: WarmupOptions,
  progress?: (p: WarmupProgress) => void,
): Promise<WarmupResult> {
  if (!Number.isInteger(candlesPerTf) || candlesPerTf < 1) throw new RangeError(`warmup: candlesPerTf ${candlesPerTf} inválido`)
  const cutoff = deps.now()
  const targets = [...new Set([...symbols, BTC_SYMBOL])]
  const tasks = targets.flatMap((symbol) =>
    WARMUP_TIMEFRAMES.flatMap((timeframe) =>
      PRICE_TYPES.map((priceType): SeriesTask => ({ symbol, timeframe, priceType, count: candlesFor(symbol, timeframe, priceType, candlesPerTf), cutoff })),
    ),
  )
  const series = new Map(targets.map((symbol) => [symbol, emptySeries()]))
  const failures = new Map<string, string>()
  let done = 0

  await forEachLimit(tasks, concurrency, async (task) => {
    // Un símbolo que ya falló no gasta más pedidos.
    if (!failures.has(task.symbol)) {
      try {
        const candles = await fetchClosed(deps, task)
        await deps.repos.candles.upsertMany({ symbol: task.symbol, timeframe: task.timeframe, priceType: task.priceType }, candles)
        series.get(task.symbol)![task.timeframe][task.priceType] = candles
      } catch (err) {
        if (!isSymbolScoped(err)) throw err
        failures.set(task.symbol, errorMessage(err))
        deps.logger.warn({ symbol: task.symbol, timeframe: task.timeframe, priceType: task.priceType, err: errorMessage(err) }, 'Calentamiento: no se pudieron traer las velas, el símbolo queda afuera')
      }
    }
    progress?.({ done: ++done, total: tasks.length })
  })

  const candles: Record<string, WarmedSymbol> = {}
  for (const [symbol, warmed] of series) if (!failures.has(symbol)) candles[symbol] = warmed
  return { candles, failed: [...failures].map(([symbol, error]) => ({ symbol, error })) }
}

// BTC 15m de último precio alimenta además la media de volatilidad de 30 días del
// contexto (spec §5.3c): la base completa más el calentamiento general.
function candlesFor(symbol: string, timeframe: WarmupTimeframe, priceType: PriceType, perTf: number): number {
  return symbol === BTC_SYMBOL && timeframe === '15m' && priceType === 'last' ? BTC_15M_CANDLES_FOR_BASELINE + perTf : perTf
}

// Las últimas `count` velas cerradas, en páginas de hasta 1.500 hacia atrás. `endTime`
// filtra por apertura: cortar un milisegundo antes de la vela en curso la deja afuera.
async function fetchClosed({ rest, budget }: WarmupDeps, { symbol, timeframe, priceType, count, cutoff }: SeriesTask): Promise<Candle[]> {
  const ms = INTERVAL_MS[timeframe]
  const fetchPage = (query: KlineQuery): Promise<Candle[]> =>
    priceType === 'last' ? rest.klines(symbol, timeframe, query) : rest.markPriceKlines(symbol, timeframe, query)
  let endTime = Math.floor(cutoff / ms) * ms - 1
  let remaining = count
  const pages: Candle[][] = []
  while (remaining > 0) {
    const limit = Math.min(remaining, MAX_KLINES_LIMIT)
    await budget.acquire('weight', klinesWeight(limit))
    const page = await fetchPage({ endTime, limit })
    // El cliente decide `closed` con su reloj: si va atrasado respecto de Binance, la
    // última vela todavía no cerró para él, no cuenta y la siguiente página la repone.
    const closed = page.filter((c) => c.closed)
    pages.unshift(closed)
    remaining -= closed.length
    const first = page[0]
    // Una página corta es el principio de la historia del contrato.
    if (first === undefined || page.length < limit) break
    endTime = first.openTime - 1
  }
  return pages.flat()
}

function emptySeries(): WarmedSymbol {
  return {
    '15m': { last: [], mark: [] },
    '1h': { last: [], mark: [] },
    '4h': { last: [], mark: [] },
  }
}
