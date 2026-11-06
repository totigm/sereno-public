import type { BtcContext, FuturesSnapshot, MarketView, SymbolInfo } from '../types'
import { buildBtcContext } from './btc-context'
import type { CandleSeries, ClosedCandles } from './candle-series'
import { lastIndexAtOrBefore } from './search'

export type ViewTimeframe = '15m' | '1h' | '4h'
export type WarmupLimits = Record<ViewTimeframe, number>

// Calentamiento de la spec §5.2: 300 velas por marco y símbolo.
export const DEFAULT_WARMUP: WarmupLimits = { '15m': 300, '1h': 300, '4h': 300 }

export interface MarketViewInput {
  t: number
  symbol: string
  info: SymbolInfo
  series: Record<ViewTimeframe, ClosedCandles>
  /**
   * Histórico de snapshots de futuros **ordenado por `at` creciente** (precondición: se busca
   * por bisección; desordenado devuelve un snapshot equivocado sin avisar).
   */
  futures: readonly FuturesSnapshot[]
  btc4h: CandleSeries
  btc15m: CandleSeries
  /**
   * Contexto de BTC ya calculado con `buildBtcContext` para este mismo `t` y `warmup['4h']`.
   * Es igual para todos los símbolos de un ciclo: el motor lo arma una vez y lo comparte en
   * lugar de recorrer 2881 velas de BTC por símbolo. Si viene, `btc4h` y `btc15m` no se leen.
   */
  btc?: BtcContext
  markPrice: number
  lastPrice: number
  warmup: WarmupLimits
}

const byAt = (s: FuturesSnapshot): number => s.at

// Arma la vista fechada en `t` que recibe el motor (spec §5.2): sólo velas cerradas
// con `closeTime ≤ t`, el último snapshot de futuros con `at ≤ t`, y el contexto de BTC
// calculado con la misma regla. Pura: no mira el reloj ni muta las series.
export function buildMarketView(input: MarketViewInput): MarketView {
  const { t, symbol, info, series, futures, btc4h, btc15m, btc, markPrice, lastPrice, warmup } = input
  return {
    t,
    symbol,
    info,
    candles: {
      '15m': series['15m'].closedUpTo(t, warmup['15m']),
      '1h': series['1h'].closedUpTo(t, warmup['1h']),
      '4h': series['4h'].closedUpTo(t, warmup['4h']),
    },
    futures: latestSnapshotAtOrBefore(futures, t),
    btc: btc ?? buildBtcContext({ t, btc4h, btc15m, warmup4h: warmup['4h'] }),
    markPrice,
    lastPrice,
  }
}

function latestSnapshotAtOrBefore(futures: readonly FuturesSnapshot[], t: number): FuturesSnapshot | null {
  return futures[lastIndexAtOrBefore(futures, byAt, t)] ?? null
}
