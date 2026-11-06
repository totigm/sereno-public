// Rango verdadero y ATR de Wilder.
//
//   tr[i]  = max(high[i] − low[i], |high[i] − close[i − 1]|, |low[i] − close[i − 1]|)   (i ≥ 1)
//   atr    = RMA(tr, period)
//
// El rango verdadero necesita el cierre anterior, así que `tr[0]` es NaN (la
// convención de TA-Lib: no se inventa un TR sin hueco para la primera vela).
// Calentamiento: `atr` es NaN para i < period.
import type { Candle } from '../types'
import { nanArray } from './series'
import { rma } from './wilder'

export function trueRange(candles: readonly Candle[]): number[] {
  const out = nanArray(candles.length)
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i]!
    const previousClose = candles[i - 1]!.close
    out[i] = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose))
  }
  return out
}

export function atr(candles: readonly Candle[], period = 14): number[] {
  return rma(trueRange(candles), period)
}
