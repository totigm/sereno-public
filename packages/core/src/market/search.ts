// Búsqueda binaria sobre un arreglo ordenado de forma creciente por una clave numérica.
// Devuelve el índice del último elemento con clave ≤ `key`, o −1 si no hay ninguno.
export function lastIndexAtOrBefore<T>(items: readonly T[], keyOf: (item: T) => number, key: number): number {
  let lo = 0
  let hi = items.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (keyOf(items[mid] as T) <= key) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
