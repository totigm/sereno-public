// Tendencia 15m (spec §5.3a): EMA 20/50/200 y pendiente de la EMA20 sobre cierres de 15m.
//   valor = (sgn(EMA20 − EMA50) + sgn(EMA50 − EMA200) + sgn(pendiente EMA20)) / 3   ∈ [−1, +1]
// Signo: + = long (EMAs ordenadas al alza y EMA20 subiendo), − = short.
// null sin 200 velas de 15m.
import type { MarketView, SignalResult } from '../types'
import { emaTrend } from './ema-trend'
import { closesOf, noData, signalResult } from './result'

export function trend15m(view: MarketView): SignalResult {
  const trend = emaTrend(closesOf(view.candles['15m']))
  if (trend === null) return noData('trend15m')
  const { score, ...detail } = trend
  return signalResult('trend15m', score, detail)
}
