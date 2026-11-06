// Canal de Donchian sobre las `period` velas ANTERIORES a la actual.
//
//   upper[i] = max(high[i − period .. i − 1])
//   lower[i] = min(low[i − period .. i − 1])
//
// La vela `i` queda afuera a propósito (spec §5.3, señal de ruptura): la
// ruptura se mide comparando el cierre de `i` contra el canal de las previas;
// si la vela entrara en su propio canal, nunca podría cerrar por encima de él.
// Calentamiento: NaN para i < period.
import type { Candle } from '../types'
import { assertPeriod, nanArray } from './series'

export interface DonchianResult {
  upper: number[]
  lower: number[]
}

export function donchian(candles: readonly Candle[], period = 20): DonchianResult {
  assertPeriod(period)
  const upper = nanArray(candles.length)
  const lower = nanArray(candles.length)
  for (let i = period; i < candles.length; i++) {
    let max = Number.NEGATIVE_INFINITY
    let min = Number.POSITIVE_INFINITY
    for (let j = i - period; j < i; j++) {
      const candle = candles[j]!
      if (candle.high > max) max = candle.high
      if (candle.low < min) min = candle.low
    }
    upper[i] = max
    lower[i] = min
  }
  return { upper, lower }
}
