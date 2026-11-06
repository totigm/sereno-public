// Media móvil simple.
//
//   sma[i] = (x[i − period + 1] + … + x[i]) / period
//
// Calentamiento: NaN para i < period − 1. Un NaN dentro de la ventana da NaN
// sólo en las ventanas que lo contienen (por eso se suma cada ventana de nuevo
// en lugar de llevar una suma rodante, que lo propagaría para siempre).
import { assertPeriod, nanArray } from './series'

export function sma(values: readonly number[], period: number): number[] {
  assertPeriod(period)
  const out = nanArray(values.length)
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!
    out[i] = sum / period
  }
  return out
}
