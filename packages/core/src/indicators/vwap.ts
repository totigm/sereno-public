// VWAP anclado al día: precio medio ponderado por volumen desde el inicio del día.
//
//   typical[i] = (high[i] + low[i] + close[i]) / 3
//   vwap[i]    = Σ typical · volume / Σ volume      sobre las velas del mismo día que `i`
//
// El día de una vela es `dayStartOf(openTime)`; cuando cambia, los acumulados se
// reinician. Con `utcDayStart` el día es el de `openTime` en UTC: una vela que cruza
// la medianoche cuenta entera para el día en que abrió. Se usa el precio típico (y no `quoteVolume / volume`) para que el
// cálculo dependa sólo del OHLCV y sea el mismo con velas sintéticas de replay.
// Sin calentamiento: hay valor desde la primera vela. Mientras el día no acumule
// volumen (0 / 0) el valor es NaN.
import type { Candle } from '../types'
import { nanArray } from './series'

const DAY_MS = 86_400_000

/** Medianoche UTC del día que contiene `t` (ms epoch). */
export function utcDayStart(t: number): number {
  return t - (((t % DAY_MS) + DAY_MS) % DAY_MS)
}

export function vwapDaily(candles: readonly Candle[], dayStartOf: (t: number) => number): number[] {
  const out = nanArray(candles.length)
  let currentDay: number | null = null
  let priceVolume = 0
  let volume = 0
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!
    const day = dayStartOf(candle.openTime)
    if (day !== currentDay) {
      currentDay = day
      priceVolume = 0
      volume = 0
    }
    const typical = (candle.high + candle.low + candle.close) / 3
    priceVolume += typical * candle.volume
    volume += candle.volume
    if (volume > 0) out[i] = priceVolume / volume
  }
  return out
}
