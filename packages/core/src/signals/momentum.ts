// Momentum (spec §5.3a): RSI(14) y MACD(12, 26, 9) en 15m.
//   rsiPart  = (RSI − 50) / 25 entre 25 y 75; con RSI > 75 vale −(RSI − 75) / 25 y con RSI < 25, +(25 − RSI) / 25
//   macdPart = clamp(histograma / ATR(14)_15m, −1, +1)   (0 si el ATR es 0)
//   valor    = 0,5 · rsiPart + 0,5 · macdPart   ∈ [−1, +1]
// Signo: + = long. La sobrecompra (RSI > 75) y la sobreventa (< 25) restan al lado que el RSI confirmaría.
import { atr } from '../indicators/atr'
import { macd } from '../indicators/macd'
import { rsi } from '../indicators/rsi'
import type { MarketView, SignalResult } from '../types'
import { clamp, closesOf, noData, signalResult } from './result'

const RSI_PERIOD = 14
const ATR_PERIOD = 14
const OVERBOUGHT = 75
const OVERSOLD = 25
// Distancia del RSI al centro que satura su mitad: 50 ± 25 son justo los umbrales de extremo.
const RSI_SPAN = 25

export interface MomentumInputs {
  rsi: number
  histogram: number
  atr: number
}

// En la zona extrema el aporte cambia de signo y crece con lo extremo del RSI: ese salto en
// 75/25 es lo que pide la spec ("restan"), no un suavizado.
function rsiPart(value: number): number {
  if (value > OVERBOUGHT) return -(value - OVERBOUGHT) / RSI_SPAN
  if (value < OVERSOLD) return (OVERSOLD - value) / RSI_SPAN
  return (value - 50) / RSI_SPAN
}

function macdPart(histogram: number, atrValue: number): number {
  return atrValue > 0 ? clamp(histogram / atrValue, -1, 1) : 0
}

export function momentumValue({ rsi: rsiValue, histogram, atr: atrValue }: MomentumInputs): number {
  return 0.5 * rsiPart(rsiValue) + 0.5 * macdPart(histogram, atrValue)
}

export function momentum(view: MarketView): SignalResult {
  const candles = view.candles['15m']
  const last = candles.length - 1
  if (last < 0) return noData('momentum')
  const closes = closesOf(candles)
  const inputs: MomentumInputs = {
    rsi: rsi(closes, RSI_PERIOD)[last]!,
    histogram: macd(closes).histogram[last]!,
    atr: atr(candles, ATR_PERIOD)[last]!,
  }
  if (!Object.values(inputs).every(Number.isFinite)) return noData('momentum')
  return signalResult('momentum', momentumValue(inputs), { ...inputs })
}
