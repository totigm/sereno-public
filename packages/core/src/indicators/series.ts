// Utilidades compartidas por los indicadores. Sin estado: cada función recibe
// todo lo que necesita y devuelve un array nuevo, alineado con la entrada.

export function nanArray(length: number): number[] {
  return new Array<number>(length).fill(Number.NaN)
}

/** Los períodos son enteros ≥ 1; cualquier otra cosa es un error de programación. */
export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} debe ser un entero ≥ 1 (recibido ${period})`)
  }
}

/** Índice del primer valor finito, o `values.length` si no hay ninguno. */
export function firstFiniteIndex(values: readonly number[]): number {
  const i = values.findIndex(Number.isFinite)
  return i === -1 ? values.length : i
}

/**
 * Suavizado exponencial recursivo con semilla SMA:
 *
 *   s[seed] = media(x[start .. start + period − 1])
 *   s[i]    = s[i − 1] + alpha · (x[i] − s[i − 1])        para i > seed
 *
 * `start` es el primer valor finito: los NaN iniciales se saltan para poder
 * encadenar indicadores (p. ej. la señal del MACD es la EMA de una línea que
 * calienta 25 velas). Devuelve NaN hasta la semilla. Un valor no finito después
 * de la semilla contamina el resto de la serie: no hay forma honesta de seguir.
 */
export function smoothRecursive(values: readonly number[], period: number, alpha: number): number[] {
  assertPeriod(period)
  const out = nanArray(values.length)
  const start = firstFiniteIndex(values)
  const seedIndex = start + period - 1
  if (seedIndex >= values.length) return out

  let sum = 0
  for (let i = start; i <= seedIndex; i++) sum += values[i]!
  let s = sum / period
  out[seedIndex] = s
  for (let i = seedIndex + 1; i < values.length; i++) {
    s += alpha * (values[i]! - s)
    out[i] = s
  }
  return out
}
