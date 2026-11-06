// Intervalo de confianza de la media por bootstrap (percentiles). El azar entra
// por `rng` (un `() => number` en [0, 1)): con un generador con semilla el
// resultado es determinista, que es lo que exige el veredicto en tests y replays.

export interface BootstrapOptions {
  rng: () => number
  resamples: number
  /** Nivel de confianza, 0,95 por defecto. */
  level?: number
}

export function bootstrapMeanCi(values: readonly number[], opts: BootstrapOptions): [number, number] {
  const n = values.length
  if (n === 0) return [0, 0]
  const level = opts.level ?? 0.95

  const means = new Float64Array(opts.resamples)
  for (let b = 0; b < opts.resamples; b++) {
    let total = 0
    for (let i = 0; i < n; i++) {
      // `Math.min` cubre un rng que devuelva exactamente 1.
      const index = Math.min(n - 1, Math.floor(opts.rng() * n))
      total += values[index] ?? 0
    }
    means[b] = total / n
  }
  means.sort()

  const alpha = (1 - level) / 2
  const last = opts.resamples - 1
  const lo = means[Math.floor(alpha * last)] ?? 0
  const hi = means[Math.ceil((1 - alpha) * last)] ?? 0
  return [lo, hi]
}
