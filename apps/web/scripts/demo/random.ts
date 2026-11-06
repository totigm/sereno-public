// Azar con semilla para los datos de demostración: misma semilla, mismos datos.
// Cada parte del escenario pide su propio flujo con `seedFrom(seed, …etiquetas)`,
// así agregar una moneda o un trade no corre los números de todo lo demás.

export interface Rng {
  /** Uniforme en [0, 1). */
  next(): number
  /** Normal estándar. */
  normal(): number
  between(lo: number, hi: number): number
  /** Entero en [lo, hi]. */
  int(lo: number, hi: number): number
  pick<T>(items: readonly T[]): T
}

// mulberry32: 32 bits de estado, rápido y con buena distribución para esto.
export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    // Box–Muller; `1 − u` evita el logaritmo de 0.
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    between: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)]
      if (item === undefined) throw new RangeError('pick sobre una lista vacía')
      return item
    },
  }
}

// FNV-1a sobre la semilla y las etiquetas: una semilla derivada estable por nombre.
export function seedFrom(seed: number, ...labels: readonly (string | number)[]): number {
  let hash = 0x811c9dc5
  for (const char of [seed, ...labels].join('|')) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function rngFor(seed: number, ...labels: readonly (string | number)[]): Rng {
  return createRng(seedFrom(seed, ...labels))
}
