// VWAP (spec §5.3a): cierre de 15m frente al VWAP anclado al día UTC.
//   valor = +0,5 si cierre > VWAP y VWAP[i] > VWAP[i − 1]; −0,5 si cierre < VWAP y VWAP[i] < VWAP[i − 1]; 0 si no (cruzando)
// Signo: + = long. La pendiente compara dos velas del mismo día UTC: la primera vela del
// día todavía no tiene pendiente y da null, igual que un día sin volumen.
import { utcDayStart, vwapDaily } from '../indicators/vwap'
import type { MarketView, SignalResult } from '../types'
import { noData, signalResult } from './result'

export function vwap(view: MarketView): SignalResult {
  const candles = view.candles['15m']
  const last = candles.length - 1
  const current = candles[last]
  const previous = candles[last - 1]
  if (current === undefined || previous === undefined) return noData('vwap')
  if (utcDayStart(current.openTime) !== utcDayStart(previous.openTime)) return noData('vwap')

  const series = vwapDaily(candles, utcDayStart)
  const now = series[last]!
  const before = series[last - 1]!
  const close = current.close
  if (![now, before, close].every(Number.isFinite)) return noData('vwap')
  const value = close > now && now > before ? 0.5 : close < now && now < before ? -0.5 : 0
  return signalResult('vwap', value, { vwap: now, vwapPrevious: before, close })
}
