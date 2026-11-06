// Vistas sintéticas para los tests de señales. Todas están fechadas en T = 10:15 UTC
// del 2026-10-31 y cada serie termina en la última vela cerrada ≤ T (10:00 en 15m,
// 09:00 en 1h, 04:00 en 4h), como las arma `buildMarketView`.
import type { BtcContext, Candle, Composite, FuturesSnapshot, MarketView } from '../../src/types'
import { TF_MS, symbolInfo, utc } from '../market/fixtures'

export const T = utc(10, 15)

type ViewTf = '15m' | '1h' | '4h'
const LAST_OPEN: Record<ViewTf, number> = { '15m': utc(10, 0), '1h': utc(9, 0), '4h': utc(4, 0) }

export interface RunOptions {
  // Mechas: high = max(open, close) + halfRange, low = min(open, close) − halfRange.
  halfRange?: number
  volumeOf?: (i: number) => number
}

// `count` velas cerradas de `tf` cuya última es la vigente a T. El cierre de la vela i es
// `closeOf(i)` y su apertura el cierre anterior; el volumen es 10 salvo `volumeOf`.
export function run(tf: ViewTf, count: number, closeOf: (i: number) => number, options: RunOptions = {}): Candle[] {
  const halfRange = options.halfRange ?? 0
  const firstOpen = LAST_OPEN[tf] - (count - 1) * TF_MS[tf]
  return Array.from({ length: count }, (_, i) => {
    const close = closeOf(i)
    const open = i === 0 ? close : closeOf(i - 1)
    const volume = options.volumeOf?.(i) ?? 10
    const openTime = firstOpen + i * TF_MS[tf]
    return {
      openTime,
      closeTime: openTime + TF_MS[tf] - 1,
      open,
      high: Math.max(open, close) + halfRange,
      low: Math.min(open, close) - halfRange,
      close,
      volume,
      quoteVolume: volume * close,
      closed: true,
    }
  })
}

export const up = (i: number): number => 100 + 0.5 * i
export const down = (i: number): number => 250 - 0.5 * i
export const flat = (): number => 100
// Zigzag de amplitud 4 y período 8: sin tendencia, ADX bajo.
export const choppy = (i: number): number => 100 + (i % 8 < 4 ? i % 8 : 8 - (i % 8))

export const emptyBtc: BtcContext = { candles4h: [], realizedVol24h: null, realizedVol30dMean: null }

export function snapshot(overrides: Partial<FuturesSnapshot> = {}): FuturesSnapshot {
  return {
    at: T,
    fundingRate: 0.0001,
    nextFundingTime: T + 8 * TF_MS['1h'],
    openInterest: 1_000,
    openInterest1hAgo: 1_000,
    openInterest4hAgo: 1_000,
    longShortRatio: 1,
    takerRatio: 1,
    ...overrides,
  }
}

export interface ViewOptions {
  symbol?: string
  c15m?: Candle[]
  c1h?: Candle[]
  c4h?: Candle[]
  futures?: FuturesSnapshot | null
  btc?: BtcContext
}

export function viewOf(options: ViewOptions = {}): MarketView {
  const symbol = options.symbol ?? 'ETHUSDT'
  const c15m = options.c15m ?? []
  const last = c15m.at(-1)?.close ?? 100
  return {
    t: T,
    symbol,
    info: symbolInfo(symbol),
    candles: { '15m': c15m, '1h': options.c1h ?? [], '4h': options.c4h ?? [] },
    futures: options.futures ?? null,
    btc: options.btc ?? emptyBtc,
    markPrice: last,
    lastPrice: last,
  }
}

// Vista "completa": tendencias alcistas en los tres marcos y en BTC, sin datos de futuros.
export function fullView(options: ViewOptions = {}): MarketView {
  return viewOf({
    c15m: run('15m', 300, up, { halfRange: 1 }),
    c1h: run('1h', 300, up, { halfRange: 1 }),
    c4h: run('4h', 300, up, { halfRange: 1 }),
    btc: { candles4h: run('4h', 300, up, { halfRange: 1 }), realizedVol24h: null, realizedVol30dMean: null },
    ...options,
  })
}

export const unitWeights = {
  trend15m: 1,
  trendHigher: 1,
  momentum: 1,
  breakout: 1,
  bands: 1,
  vwap: 1,
  funding: 1,
  openInterest: 1,
  positioning: 1,
  btcRegime: 1,
} as const

export function compositeOf(overrides: Partial<Composite> = {}): Composite {
  return {
    S: 0.5,
    Sprime: 0.5,
    confidence: 0.5,
    signals: [],
    missing: [],
    weights: { ...unitWeights },
    modifiers: { adx: 1, vol: 1 },
    relVolume: 1,
    higherTrendAgainst: 0,
    ...overrides,
  }
}
