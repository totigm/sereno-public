import type { Decision } from '@sereno/core'
import type { MarketSymbolState, MarketSymbolView, UniverseDayEntry } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { BookResult } from './book'
import { symbolInfo, type Coin } from './coins'
import { penaltyWindows } from './decisions'
import type { Market } from './market'
import { rngFor } from './random'
import { CYCLE_MS, DAY_MS, utcDay } from './time'

// La fila viva de `market_snapshot` tal como la deja el último ciclo del bot y el
// universo de cada día de la simulación.

export interface SnapshotInput {
  coins: readonly Coin[]
  market: Market
  at: number
  decisions: readonly Decision[]
  real: BookResult
  settings: Settings
  degraded: { symbol: string; since: number } | null
}

const iso = (t: number): string => new Date(t).toISOString()

export function marketSymbols({ coins, market, at, decisions, real, settings, degraded }: SnapshotInput): MarketSymbolView[] {
  const penalties = penaltyWindows(real)
  const cooldownMs = settings.entry.cooldownCandlesAfterLoss * CYCLE_MS
  const lastDecision = new Map<string, Decision>()
  for (const d of decisions) lastDecision.set(d.symbol, d)
  return coins.map((coin) => {
    const symbol = coin.symbol
    const stale = degraded?.symbol === symbol ? degraded.since : null
    const priceTime = stale ?? at
    const markPrice = market.priceAt(symbol, priceTime)
    const sPrime = lastDecision.get(symbol)?.composite.Sprime ?? null
    const view: MarketSymbolView = {
      symbol,
      markPrice,
      change24h: markPrice / market.priceAt(symbol, priceTime - DAY_MS) - 1,
      sPrime,
      lean: sPrime ?? 0,
      state: 'ready',
    }
    const holding = real.positions.some((p) => p.position.symbol === symbol && p.closed === null)
    const penalty = penalties.get(symbol)
    const lastLoss = real.positions
      .filter((p) => p.closed && p.position.symbol === symbol && p.closed.pnlNet < 0)
      .reduce((latest, p) => Math.max(latest, p.closed?.closedAt ?? 0), 0)
    const cooldownUntil = lastLoss + cooldownMs
    let state: MarketSymbolState = 'ready'
    if (holding) state = 'in_position'
    else if (stale !== null) state = 'degraded'
    else if (penalty && at < penalty.until) state = 'penalized'
    else if (lastLoss > 0 && at < cooldownUntil) state = 'cooldown'
    view.state = state
    if (state === 'degraded' && stale !== null) view.staleSince = iso(stale)
    if (state === 'penalized' && penalty) view.stateUntil = iso(penalty.until)
    if (state === 'cooldown') view.stateUntil = iso(cooldownUntil)
    return view
  })
}

function filtersOf(coin: Coin): UniverseDayEntry['filters'] {
  const { minNotional, minQty, stepSize, tickSize, quantityPrecision, liquidationFee } = symbolInfo(coin)
  return { minNotional, minQty, stepSize, tickSize, quantityPrecision, liquidationFee }
}

export function universeDays(seed: number, coins: readonly Coin[], start: number, end: number): { day: string; symbols: UniverseDayEntry[] }[] {
  const out: { day: string; symbols: UniverseDayEntry[] }[] = []
  for (let t = start - (start % DAY_MS); t <= end; t += DAY_MS) {
    const day = utcDay(t)
    const rng = rngFor(seed, 'universo', day)
    const ranked = coins
      .map((coin) => ({ coin, volume: coin.quoteVolume24h * Math.exp(0.25 * rng.normal()) }))
      .sort((a, b) => b.volume - a.volume)
    out.push({
      day,
      symbols: ranked.map(({ coin, volume }, i) => ({
        symbol: coin.symbol,
        rank: i + 1,
        quoteVolume24h: Math.round(volume),
        pinned: false,
        filters: filtersOf(coin),
      })),
    })
  }
  return out
}
