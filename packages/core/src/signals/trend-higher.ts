// Tendencia mayor (spec §5.3a): el mismo puntaje EMA 20/50/200 en velas cerradas de 1h y 4h.
//   valor = (puntaje_1h + puntaje_4h) / 2   ∈ [−1, +1]
// Signo: + = long. null si falta cualquiera de los dos marcos (sin 200 velas): el
// promedio de un solo marco no es "la tendencia mayor".
import type { MarketView, SignalResult } from '../types'
import { emaTrendScore } from './ema-trend'
import { closesOf, noData, signalResult } from './result'

export type HigherTimeframe = '1h' | '4h'

// Puntaje de cada marco por separado; también lo usa el compuesto para `higherTrendAgainst`.
export function higherTrendScores(view: MarketView): Record<HigherTimeframe, number | null> {
  return {
    '1h': emaTrendScore(closesOf(view.candles['1h'])),
    '4h': emaTrendScore(closesOf(view.candles['4h'])),
  }
}

export function trendHigher(view: MarketView): SignalResult {
  const scores = higherTrendScores(view)
  const h1 = scores['1h']
  const h4 = scores['4h']
  if (h1 === null || h4 === null) return noData('trendHigher')
  return signalResult('trendHigher', (h1 + h4) / 2, { trend1h: h1, trend4h: h4 })
}
