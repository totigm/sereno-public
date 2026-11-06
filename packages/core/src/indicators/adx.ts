// ADX de Wilder (fuerza de la tendencia, 0–100, sin dirección).
//
//   up = high[i] − high[i − 1]      down = low[i − 1] − low[i]                 (i ≥ 1)
//   +dm = up   si up > down y up > 0, si no 0
//   −dm = down si down > up y down > 0, si no 0
//   +di = 100 · RMA(+dm, period) / RMA(tr, period)      (0 si el ATR es 0)
//   −di = 100 · RMA(−dm, period) / RMA(tr, period)
//   dx  = 100 · |+di − −di| / (+di + −di)                (0 si ambos DI son 0)
//   adx = RMA(dx, period)
//
// Calentamiento: los DI y el DX son NaN para i < period; el ADX, que suaviza el
// DX con otro período, es NaN para i < 2·period − 1 (27 velas con period = 14).
import type { Candle } from '../types'
import { trueRange } from './atr'
import { nanArray } from './series'
import { rma } from './wilder'

export function adx(candles: readonly Candle[], period = 14): number[] {
  const plusDm = nanArray(candles.length)
  const minusDm = nanArray(candles.length)
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!
    const previous = candles[i - 1]!
    const up = current.high - previous.high
    const down = previous.low - current.low
    plusDm[i] = up > down && up > 0 ? up : 0
    minusDm[i] = down > up && down > 0 ? down : 0
  }

  const smoothedTr = rma(trueRange(candles), period)
  const smoothedPlus = rma(plusDm, period)
  const smoothedMinus = rma(minusDm, period)

  const dx = nanArray(candles.length)
  for (let i = 0; i < candles.length; i++) {
    const tr = smoothedTr[i]!
    if (Number.isNaN(tr)) continue
    const plusDi = tr === 0 ? 0 : (100 * smoothedPlus[i]!) / tr
    const minusDi = tr === 0 ? 0 : (100 * smoothedMinus[i]!) / tr
    const total = plusDi + minusDi
    dx[i] = total === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / total
  }
  return rma(dx, period)
}
