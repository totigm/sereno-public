// Los datos de mercado de una sesión en vivo: calentamiento, precios por REST al retomar,
// datos de futuros, velas del ciclo y monedas sin datos recientes.

import type { MarkTick } from '@sereno/core'
import type { Repos } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import { INTERVAL_MS } from '../binance/types'
import type { SymbolFailure } from '../jobs/errors'
import { pollFuturesData } from '../jobs/futures-data'
import type { Logger } from '../logger'
import { FUTURES_LOOKBACK_MS, loadFuturesSnapshots } from '../market/futures-snapshots'
import type { FundingTracker } from './funding'
import type { MarketData } from './market-data'
import { SECOND_MS } from './scheduler'
import { warmup, type WarmupDeps } from './warmup'

// Sin datos de un símbolo por más de esto, queda degradado (spec §12).
export const STALE_DATA_MS = 60 * SECOND_MS

// Calienta las que todavía no lo están. `onProgress` recibe cuántas de `symbols` ya están
// calientes; devuelve las que fallaron (quedan degradadas).
export async function warmSymbols(
  deps: WarmupDeps & { market: MarketData },
  symbols: readonly string[],
  candlesPerTf: number,
  onProgress: (ready: number) => void,
): Promise<SymbolFailure[]> {
  const { market } = deps
  const todo = symbols.filter((s) => !market.isWarm(s))
  const ready = symbols.length - todo.length
  onProgress(ready)
  if (todo.length === 0) return []
  const result = await warmup(deps, todo, { candlesPerTf }, (p) => {
    onProgress(Math.min(symbols.length, ready + Math.floor((p.done / p.total) * todo.length)))
  })
  for (const [symbol, warmed] of Object.entries(result.candles)) market.load(symbol, warmed)
  for (const { symbol } of result.failed) market.failed.add(symbol)
  onProgress(symbols.filter((s) => market.isWarm(s)).length)
  return result.failed
}

// El precio de marca de cada contrato ahora, por REST.
export async function marksFromRest(rest: Pick<BinanceRest, 'premiumIndex'>, now: number): Promise<MarkTick[]> {
  const raw = await rest.premiumIndex()
  return (Array.isArray(raw) ? raw : [raw]).map((p) => ({
    symbol: p.symbol,
    markPrice: p.markPrice,
    lastPrice: p.markPrice,
    at: now,
    fundingRate: p.lastFundingRate,
    nextFundingTime: p.nextFundingTime,
  }))
}

export interface FuturesRefreshDeps {
  repos: Pick<Repos, 'futures'>
  rest: Pick<BinanceRest, 'openInterestHist' | 'globalLongShortAccountRatio' | 'takerLongShortRatio'>
  logger: Logger
  funding: FundingTracker
  market: MarketData
}

// Funding del stream (la última tasa conocida) y datos de futuros por REST; después se
// recargan los snapshots que ven los ciclos.
export async function refreshFutures(deps: FuturesRefreshDeps, symbols: readonly string[], at: number): Promise<void> {
  const { repos, funding } = deps
  const points = symbols.flatMap((symbol) => {
    const f = funding.get(symbol)
    if (!f || f.rate === null) return []
    return [{ symbol, at, fundingRate: f.rate, nextFundingTime: f.nextFundingTime, openInterest: null, longShortRatio: null, takerRatio: null }]
  })
  if (points.length > 0) await repos.futures.insert(points)
  await pollFuturesData(deps, symbols)
  await loadFutures(deps, symbols, at)
}

// Sólo recarga lo guardado (la sesión real lee lo que trajo la de papel).
export async function loadFutures(deps: { repos: Pick<Repos, 'futures'>; market: MarketData }, symbols: readonly string[], at: number): Promise<void> {
  for (const symbol of symbols) deps.market.setFutures(symbol, await loadFuturesSnapshots(deps.repos.futures, symbol, at - FUTURES_LOOKBACK_MS, at + 1))
}

// Las velas que cerraron con el ciclo de `t` (la de 1h y la de 4h cuando corresponde).
export async function saveCycleCandles(deps: { market: MarketData; repos: Pick<Repos, 'candles'> }, t: number, symbols: readonly string[]): Promise<void> {
  for (const symbol of symbols) {
    for (const tf of ['15m', '1h', '4h'] as const) {
      if (t % INTERVAL_MS[tf] !== 0) continue
      const candles = deps.market.closedBetween(symbol, tf, t - INTERVAL_MS[tf], t)
      if (candles.length > 0) await deps.repos.candles.upsertMany({ symbol, timeframe: tf, priceType: 'last' }, candles)
    }
  }
}

// Símbolo → desde cuándo no llegan datos. `feedSince` es cuando se abrió el stream de la
// sesión: antes de eso nada está degradado.
export function degradedSymbols(market: MarketData, symbols: readonly string[], feedSince: number | null, now: number): Map<string, number> {
  const out = new Map<string, number>()
  if (feedSince === null) return out
  for (const symbol of symbols) {
    const seen = market.lastSeen(symbol) ?? feedSince
    if (market.failed.has(symbol) || now - seen > STALE_DATA_MS) out.set(symbol, seen)
  }
  return out
}
