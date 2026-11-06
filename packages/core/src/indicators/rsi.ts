// RSI de Wilder.
//
//   gain[i] = max(c[i] − c[i − 1], 0)      loss[i] = max(c[i − 1] − c[i], 0)     (i ≥ 1)
//   avgGain = RMA(gain, period)            avgLoss = RMA(loss, period)
//   rsi = 100 · avgGain / (avgGain + avgLoss)
//
// Es la forma algebraicamente equivalente a 100 − 100 / (1 + RS) que no divide
// por cero cuando no hubo bajas (⇒ 100) ni cuando no hubo subas (⇒ 0). Si no
// hubo ni subas ni bajas (serie constante) devuelve 50, el valor neutro.
//
// Calentamiento: NaN para i < period (las diferencias arrancan en el índice 1).
import { nanArray } from './series'
import { rma } from './wilder'

export function rsi(closes: readonly number[], period = 14): number[] {
  const gains = nanArray(closes.length)
  const losses = nanArray(closes.length)
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    gains[i] = Math.max(delta, 0)
    losses[i] = Math.max(-delta, 0)
  }
  const avgGain = rma(gains, period)
  const avgLoss = rma(losses, period)

  const out = nanArray(closes.length)
  for (let i = 0; i < closes.length; i++) {
    const gain = avgGain[i]!
    const loss = avgLoss[i]!
    if (Number.isNaN(gain) || Number.isNaN(loss)) continue
    const total = gain + loss
    out[i] = total === 0 ? 50 : (100 * gain) / total
  }
  return out
}
