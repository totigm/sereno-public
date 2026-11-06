import type { Candle, CloseReason } from '@sereno/core'
import type { Settings } from '@sereno/shared'
import { buildCandles, candleNoise } from './candles'
import { symbolInfo, type Coin } from './coins'
import { walkTrade, type Walk } from './exits'
import { gridPoints, priceAt, type Grid, type GridPoints } from './grid'
import { basePaths, shapePath, type Anchor } from './path'
import { planTrade, type Leg, type TradePlan } from './plans'
import { rngFor } from './random'
import type { TradeSpec } from './spec'
import { CLOSE_LATENCY_MS, OPEN_LATENCY_MS } from './time'

// El mercado de un escenario: un camino de precios por moneda que pasa por cada
// entrada y salida pedida, sus velas, y lo que las reglas de salida hicieron con cada
// trade (salida, movimientos del stop, mejor precio). Lo comparten las dos carteras y
// todas las sesiones del escenario: la tabla de velas es una sola.

export interface StopMoveAt {
  at: number
  from: number
  to: number
}

export interface TradeOutcome {
  exit: { reason: CloseReason; at: number; price: number } | null
  moves: StopMoveAt[]
  best: number
  trailingActive: boolean
  stop: number
}

export interface TradeMarket {
  plan: TradePlan
  openedAt: number
  real: TradeOutcome
  shadow: TradeOutcome
}

export interface Market {
  points: GridPoints
  prices: Map<string, Float64Array>
  candles: Map<string, Candle[]>
  trades: Map<string, TradeMarket>
  priceAt(symbol: string, t: number): number
}

export interface MarketInput {
  seed: number
  coins: readonly Coin[]
  grid: Grid
  trades: readonly TradeSpec[]
  // Salidas y riesgo con que se calculan los niveles (los valores por defecto: los
  // comparten la cartera real y la sombra).
  settings: Pick<Settings, 'risk' | 'exits' | 'entry'>
}

const MAX_ATTEMPTS = 16
// El fill de una orden condicional ocurre dentro de la vela; los movimientos del
// trailing, en el tramo favorable de la vela.
const TRIGGER_FRACTION = 0.55
const MOVE_FRACTION = 0.6

// Un instante dentro de la vela: en la vela todavía abierta, dentro de lo que ya pasó
// de ella (su máximo y su mínimo son los de hasta ahora).
function withinCandle(candle: Candle, fraction: number, marketEnd: number): number {
  return candle.openTime + fraction * (Math.min(candle.closeTime + 1, marketEnd) - candle.openTime)
}

interface Window {
  start: number
  end: number
  texture: number
}

function windowsOf(plans: readonly TradePlan[]): Window[] {
  const sorted = plans
    .map((p) => ({ start: p.openIndex, end: Math.max(p.real.end, p.shadow.end) }))
    .sort((a, b) => a.start - b.start)
  const merged: Window[] = []
  for (const w of sorted) {
    const last = merged[merged.length - 1]
    if (last && w.start < last.end) last.end = Math.max(last.end, w.end)
    else merged.push({ ...w, texture: 1 })
  }
  return merged
}

function legHolds(leg: Leg, walk: Walk): boolean {
  if (leg.expect === null) return walk.exit === null
  return walk.exit?.reason === leg.expect.reason && walk.exit.candle === leg.expect.candle
}

function walkLeg(plan: TradePlan, leg: Leg, candles: readonly Candle[], points: GridPoints, settings: MarketInput['settings']): Walk {
  const to = Math.min(leg.to, candles.length)
  return walkTrade(plan.levels, settings.exits, candles, plan.openIndex, to, points.times[plan.openIndex] ?? 0)
}

interface CoinMarket {
  prices: Float64Array
  candles: Candle[]
  walks: Map<string, { real: Walk; shadow: Walk }>
}

function buildCoin(seed: number, coin: Coin, base: Float64Array, points: GridPoints, plans: TradePlan[], settings: MarketInput['settings']): CoinMarket {
  const last = points.times.length - 1
  const anchors: Anchor[] = [{ index: last, price: coin.price }, ...plans.flatMap((p) => p.anchors)]
  const unique = new Map<number, number>()
  for (const a of anchors) {
    const seen = unique.get(a.index)
    if (seen !== undefined && Math.abs(seen / a.price - 1) > 1e-12) {
      throw new Error(`${coin.symbol}: dos trades piden precios distintos en el mismo cierre de vela`)
    }
    unique.set(a.index, a.price)
  }
  const anchorList = [...unique].map(([index, price]) => ({ index, price }))
  const windows = windowsOf(plans)
  const textureAt = (i: number): number => windows.find((w) => i >= w.start && i < w.end)?.texture ?? 1
  const noise = candleNoise(seed, coin, points)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const prices = shapePath(base, anchorList, textureAt)
    const candles = buildCandles({ coin, prices, points, noise, wickScale: textureAt })
    const walks = new Map<string, { real: Walk; shadow: Walk }>()
    const failing = new Set<Window>()
    for (const plan of plans) {
      const real = walkLeg(plan, plan.real, candles, points, settings)
      const shadow = plan.shadow === plan.real ? real : walkLeg(plan, plan.shadow, candles, points, settings)
      walks.set(plan.spec.id, { real, shadow })
      if (!legHolds(plan.real, real) || !legHolds(plan.shadow, shadow)) {
        const w = windows.find((x) => plan.openIndex >= x.start && plan.openIndex < x.end)
        if (w) failing.add(w)
      }
    }
    if (failing.size === 0) return { prices, candles, walks }
    // Menos textura en el tramo que falló: con 0 el camino es una recta entre anclajes
    // y las salidas pedidas se cumplen por construcción.
    for (const w of failing) w.texture = attempt >= MAX_ATTEMPTS - 2 ? 0 : w.texture / 2
  }
  throw new Error(`${coin.symbol}: no encontré un camino que cumpla las salidas pedidas; revisá el escenario`)
}

function outcomeOf(plan: TradePlan, leg: Leg, walk: Walk, prices: Float64Array, candles: readonly Candle[], points: GridPoints, closeLatency: number): TradeOutcome {
  const marketEnd = points.times[points.times.length - 1] ?? 0
  const moves = walk.moves.map((m) => {
    const candle = candles[m.candle]
    if (!candle) throw new Error(`El trailing de ${plan.spec.id} se movió fuera de las velas`)
    return { at: withinCandle(candle, MOVE_FRACTION, marketEnd), from: m.from, to: m.to }
  })
  const state = { moves, best: walk.best, trailingActive: walk.trailingActive, stop: walk.stop }
  if (leg.market) {
    return { ...state, exit: { reason: leg.market.reason, at: (points.times[leg.market.index] ?? 0) + closeLatency, price: prices[leg.market.index] ?? NaN } }
  }
  if (!walk.exit) return { ...state, exit: null }
  const candle = candles[walk.exit.candle]
  if (!candle) throw new Error(`El trade ${plan.spec.id} salió fuera de las velas`)
  // La salida por tiempo la decide el ciclo, al cierre de la vela; las órdenes del
  // exchange disparan dentro de la vela.
  const at = walk.exit.reason === 'time_exit' ? candle.closeTime + 1 + closeLatency : withinCandle(candle, TRIGGER_FRACTION, marketEnd)
  return { ...state, exit: { reason: walk.exit.reason, at, price: walk.exit.price } }
}

export function buildMarket({ seed, coins, grid, trades, settings }: MarketInput): Market {
  const known = new Set(coins.map((c) => c.symbol))
  const ids = new Set<string>()
  for (const spec of trades) {
    if (!known.has(spec.symbol)) throw new Error(`El trade ${spec.id} es de una moneda fuera del mercado: ${spec.symbol}`)
    if (ids.has(spec.id)) throw new Error(`Dos trades con el mismo id: ${spec.id}`)
    ids.add(spec.id)
  }
  const points = gridPoints(grid)
  const bases = basePaths(seed, coins, points)
  const prices = new Map<string, Float64Array>()
  const candles = new Map<string, Candle[]>()
  const out = new Map<string, TradeMarket>()

  for (const coin of coins) {
    const base = bases.get(coin.symbol)
    if (!base) continue
    const own = trades.filter((t) => t.symbol === coin.symbol).sort((a, b) => a.open - b.open)
    const decided = new Map<number, number>([[points.times.length - 1, coin.price]])
    const plans: TradePlan[] = []
    for (const spec of own) {
      const plan = planTrade(spec, coin, symbolInfo(coin), {
        times: points.times,
        lastBoundary: points.lastBoundary,
        priceAt: (index) => decided.get(index) ?? Math.exp(base[index] ?? 0),
        settings,
      })
      for (const a of plan.anchors) decided.set(a.index, a.price)
      plans.push(plan)
    }
    const built = buildCoin(seed, coin, base, points, plans, settings)
    prices.set(coin.symbol, built.prices)
    candles.set(coin.symbol, built.candles)
    for (const plan of plans) {
      const walks = built.walks.get(plan.spec.id)
      if (!walks) continue
      const rng = rngFor(seed, 'latencia', plan.spec.id)
      const openLatency = Math.round(rng.between(OPEN_LATENCY_MS.min, OPEN_LATENCY_MS.max))
      const closeLatency = Math.round(rng.between(CLOSE_LATENCY_MS.min, CLOSE_LATENCY_MS.max))
      const real = outcomeOf(plan, plan.real, walks.real, built.prices, built.candles, points, closeLatency)
      const shadow = plan.shadow === plan.real ? real : outcomeOf(plan, plan.shadow, walks.shadow, built.prices, built.candles, points, closeLatency)
      out.set(plan.spec.id, { plan, openedAt: (points.times[plan.openIndex] ?? 0) + openLatency, real, shadow })
    }
  }

  return {
    points,
    prices,
    candles,
    trades: out,
    priceAt(symbol, t) {
      const series = prices.get(symbol)
      if (!series) throw new Error(`Sin precios para ${symbol}`)
      return priceAt(series, points, t)
    },
  }
}
