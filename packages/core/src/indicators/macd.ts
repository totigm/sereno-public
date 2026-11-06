// MACD.
//
//   macd      = EMA(closes, fast) − EMA(closes, slow)
//   signal    = EMA(macd, signalPeriod)
//   histogram = macd − signal
//
// Calentamiento: `macd` es NaN para i < slow − 1; `signal` e `histogram` para
// i < slow − 1 + signalPeriod − 1 (con 12/26/9: 25 y 33 velas).
import { ema } from './ema'
import { assertPeriod } from './series'

export interface MacdResult {
  macd: number[]
  signal: number[]
  histogram: number[]
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  assertPeriod(fast, 'fast')
  assertPeriod(slow, 'slow')
  assertPeriod(signalPeriod, 'signalPeriod')
  if (fast >= slow) throw new RangeError(`fast (${fast}) debe ser menor que slow (${slow})`)

  const fastEma = ema(closes, fast)
  const slowEma = ema(closes, slow)
  const line = fastEma.map((f, i) => f - slowEma[i]!)
  const signal = ema(line, signalPeriod)
  const histogram = line.map((m, i) => m - signal[i]!)
  return { macd: line, signal, histogram }
}
