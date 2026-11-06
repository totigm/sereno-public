// Media móvil exponencial.
//
//   α = 2 / (period + 1)
//   ema[period − 1] = SMA de los primeros `period` valores (semilla)
//   ema[i] = ema[i − 1] + α · (x[i] − ema[i − 1])
//
// Calentamiento: NaN para i < period − 1 (contado desde el primer valor finito:
// los NaN iniciales de la entrada se saltan para poder encadenar indicadores).
import { smoothRecursive } from './series'

export function ema(values: readonly number[], period: number): number[] {
  return smoothRecursive(values, period, 2 / (period + 1))
}
