// Media móvil de Wilder (RMA), el suavizado que usan RSI, ATR y ADX.
//
//   rma[seed] = media de los primeros `period` valores finitos
//   rma[i]    = (rma[i − 1] · (period − 1) + x[i]) / period
//             = rma[i − 1] + (x[i] − rma[i − 1]) / period      (una EMA con α = 1/period)
//
// Calentamiento: NaN hasta la semilla; los NaN iniciales de la entrada se saltan
// (los indicadores de Wilder arrancan en el índice 1 porque necesitan la vela anterior).
import { smoothRecursive } from './series'

export function rma(values: readonly number[], period: number): number[] {
  return smoothRecursive(values, period, 1 / period)
}
