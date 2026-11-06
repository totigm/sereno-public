// Régimen BTC (spec §5.3a): puntaje EMA 20/50/200 sobre las velas cerradas de 4h de BTC.
//   valor = 0,5 × puntaje EMA_4h(BTC)   (±0,5 con BTC en tendencia plena, proporcional en el medio)
// Signo: + = long (BTC alcista acompaña a los longs en las alts), − = short.
// BTCUSDT mismo vale 0 (no se compara consigo mismo); null sin 200 velas de 4h de BTC.
import type { MarketView, SignalResult } from '../types'
import { emaTrendScore } from './ema-trend'
import { closesOf, noData, signalResult } from './result'

const BTC_SYMBOL = 'BTCUSDT'
const MAX_ABS_VALUE = 0.5

export function btcRegime(view: MarketView): SignalResult {
  if (view.symbol === BTC_SYMBOL) return signalResult('btcRegime', 0)
  const score = emaTrendScore(closesOf(view.btc.candles4h))
  if (score === null) return noData('btcRegime')
  return signalResult('btcRegime', MAX_ABS_VALUE * score, { btcTrend4h: score })
}
