import { alignDown } from './time'

// Los instantes de una serie de precios: un punto en cada cierre de vela desde
// `start` y, si el último cierre quedó antes de `end`, un punto más en `end` (el
// precio de la vela todavía abierta).
export interface Grid {
  start: number
  step: number
  end: number
}

export interface GridPoints {
  times: number[]
  // Índice del último cierre de vela (el punto siguiente, si existe, es `end`).
  lastBoundary: number
}

export function gridPoints(grid: Grid): GridPoints {
  if (grid.start % grid.step !== 0) throw new RangeError('La grilla tiene que arrancar en un cierre de vela')
  const last = alignDown(grid.end, grid.step)
  const times: number[] = []
  for (let t = grid.start; t <= last; t += grid.step) times.push(t)
  const lastBoundary = times.length - 1
  if (grid.end > last) times.push(grid.end)
  return { times, lastBoundary }
}

// Precio en cualquier instante: interpolación en escala logarítmica entre los
// puntos vecinos (fuera de la serie, el extremo más cercano).
export function priceAt(prices: Float64Array, points: GridPoints, t: number): number {
  const { times } = points
  const first = times[0]
  const lastTime = times[times.length - 1]
  if (first === undefined || lastTime === undefined) throw new RangeError('Serie vacía')
  if (t <= first) return prices[0] ?? NaN
  if (t >= lastTime) return prices[times.length - 1] ?? NaN
  let lo = 0
  let hi = times.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((times[mid] ?? 0) <= t) lo = mid
    else hi = mid
  }
  const t0 = times[lo] ?? 0
  const t1 = times[hi] ?? 0
  const w = (t - t0) / (t1 - t0)
  const p0 = prices[lo] ?? NaN
  const p1 = prices[hi] ?? NaN
  return Math.exp((1 - w) * Math.log(p0) + w * Math.log(p1))
}
