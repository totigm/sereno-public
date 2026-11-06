// Bandas de Bollinger.
//
//   middle = SMA(closes, period)
//   sd     = desvío estándar poblacional de la ventana (÷ period, como TA-Lib y TradingView)
//   upper  = middle + mult · sd        lower = middle − mult · sd
//   pctB   = (close − lower) / (upper − lower)
//
// El desvío se calcula en dos pasadas sobre la ventana (media y luego desvíos),
// que es exacto para una serie constante (banda cero) y numéricamente estable.
// Si la banda tiene ancho cero no hay posición dentro de ella: `pctB` es NaN.
// Calentamiento: NaN para i < period − 1 en las cuatro series.
import { assertPeriod, nanArray } from './series'
import { sma } from './sma'

export interface BollingerResult {
  upper: number[]
  middle: number[]
  lower: number[]
  pctB: number[]
}

export function bollinger(closes: readonly number[], period = 20, mult = 2): BollingerResult {
  assertPeriod(period)
  const middle = sma(closes, period)
  const upper = nanArray(closes.length)
  const lower = nanArray(closes.length)
  const pctB = nanArray(closes.length)

  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i]!
    let squares = 0
    for (let j = i - period + 1; j <= i; j++) squares += (closes[j]! - mean) ** 2
    const sd = Math.sqrt(squares / period)
    upper[i] = mean + mult * sd
    lower[i] = mean - mult * sd
    const width = upper[i]! - lower[i]!
    if (width > 0) pctB[i] = (closes[i]! - lower[i]!) / width
  }
  return { upper, middle, lower, pctB }
}
