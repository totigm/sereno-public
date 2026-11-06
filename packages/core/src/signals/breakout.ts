// Ruptura (spec §5.3a): canal de Donchian(20) sobre las 20 velas de 15m ANTERIORES a la de decisión.
//   valor = +1 si cierre > máximo del canal, −1 si cierre < mínimo, 0 en el medio (igualar no rompe)
// Signo: + = long (ruptura al alza), − = short. null sin 21 velas.
import { donchian } from '../indicators/donchian'
import type { MarketView, SignalResult } from '../types'
import { noData, signalResult } from './result'

const CHANNEL_PERIOD = 20

export function breakout(view: MarketView): SignalResult {
  const candles = view.candles['15m']
  const last = candles.length - 1
  if (last < 0) return noData('breakout')
  const channel = donchian(candles, CHANNEL_PERIOD)
  const upper = channel.upper[last]!
  const lower = channel.lower[last]!
  const close = candles[last]!.close
  if (![upper, lower, close].every(Number.isFinite)) return noData('breakout')
  const value = close > upper ? 1 : close < lower ? -1 : 0
  return signalResult('breakout', value, { upper, lower, close })
}
