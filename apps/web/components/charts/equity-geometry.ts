import { scaleLinear, type ScaleLinear } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'
import type { EquityPointView } from '@/lib/queries/sql/equity'

// La geometría de la curva de equity (spec §11.1): una sola curva con su área, sólida
// donde los puntos son continuos y punteada en los huecos de más de 5 minutos (los
// tramos son intervalos de x para recortarla), y el hueco del final (bot sin conexión)
// hasta el borde derecho. El SVG mide W × H y se estira al ancho del contenedor con
// trazos que no escalan.

export const CHART_W = 600
export const CHART_H = 200
const PAD_TOP = 12
const PAD_BOTTOM = 8

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Un tramo de x: dónde la curva va sólida (puntos continuos) o punteada (hueco). */
export interface Interval {
  x1: number
  x2: number
}

export interface EquityGeometry {
  x: ScaleLinear<number, number>
  y: (value: number) => number
  ticks: number[]
  line: string
  area: string
  solid: Interval[]
  gaps: Interval[]
  /** Con un solo punto no hay curva: va un punto. */
  dot: { x: number; y: number } | null
  /** Del último punto al final del rango, cuando la curva se cortó antes (sin conexión). */
  trailing: Segment | null
  saldo: string | null
  shadow: string | null
  end: { x: number; y: number }
}

export interface GeometryInput {
  points: EquityPointView[]
  from: number
  to: number
  showSaldo: boolean
  showShadow: boolean
  /** A partir de cuánto sin puntos al final se dibuja el hueco. */
  trailingGapMs: number
}

/** Los tramos continuos: se corta donde el punto trae `gapBefore`. */
export function splitRuns(points: EquityPointView[]): EquityPointView[][] {
  const runs: EquityPointView[][] = []
  for (const p of points) {
    const last = runs.at(-1)
    if (!last || p.gapBefore) runs.push([p])
    else last.push(p)
  }
  return runs
}

function domainOf(points: EquityPointView[], showSaldo: boolean, showShadow: boolean): [number, number] {
  const values: number[] = []
  for (const p of points) {
    values.push(p.equity)
    if (showSaldo) values.push(p.saldo)
    if (showShadow && p.shadowEquity !== null) values.push(p.shadowEquity)
  }
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  // Con la curva casi plana no se hace zoom sobre centavos: el piso del margen es US$ 1 o el 0,2%.
  const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.002, 1)
  return [lo - pad, hi + pad]
}

export function equityGeometry({ points, from, to, showSaldo, showShadow, trailingGapMs }: GeometryInput): EquityGeometry | null {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return null
  const start = Math.min(from, first.at)
  const stop = Math.max(to, last.at, start + 1)
  const x = scaleLinear().domain([start, stop]).range([0, CHART_W])
  // Sin `nice()`: redondear el dominio deja medio gráfico vacío cuando la curva se mueve poco.
  const y = scaleLinear()
    .domain(domainOf(points, showSaldo, showShadow))
    .range([CHART_H - PAD_BOTTOM, PAD_TOP])

  const equityLine = line<EquityPointView>()
    .x((p) => x(p.at))
    .y((p) => y(p.equity))
    .curve(curveMonotoneX)
  const equityArea = area<EquityPointView>()
    .x((p) => x(p.at))
    .y0(CHART_H)
    .y1((p) => y(p.equity))
    .curve(curveMonotoneX)
  const saldoLine = line<EquityPointView>()
    .x((p) => x(p.at))
    .y((p) => y(p.saldo))
    .curve(curveMonotoneX)
  // La sombra puede faltar en algunos puntos: la línea se corta ahí en vez de caer a cero.
  const shadowLine = line<EquityPointView>()
    .defined((p) => p.shadowEquity !== null)
    .x((p) => x(p.at))
    .y((p) => y(p.shadowEquity ?? 0))
    .curve(curveMonotoneX)

  const runs = splitRuns(points)
  const solid: Interval[] = []
  const gaps: Interval[] = []
  runs.forEach((run, i) => {
    const a = run[0]
    const b = run.at(-1)
    if (a && b && b.at > a.at) solid.push({ x1: x(a.at), x2: x(b.at) })
    const next = runs[i + 1]?.[0]
    if (b && next) gaps.push({ x1: x(b.at), x2: x(next.at) })
  })
  const end = { x: x(last.at), y: y(last.equity) }
  const shadow = showShadow ? (shadowLine(points) ?? '') : ''

  return {
    x,
    y,
    ticks: y.ticks(3),
    line: equityLine(points) ?? '',
    area: equityArea(points) ?? '',
    solid,
    gaps,
    dot: points.length === 1 ? end : null,
    trailing: stop - last.at > trailingGapMs ? { x1: end.x, y1: end.y, x2: CHART_W, y2: end.y } : null,
    saldo: showSaldo ? (saldoLine(points) ?? '') : null,
    shadow: shadow === '' ? null : shadow,
    end,
  }
}

/** El índice del punto más cercano a `at` (los puntos vienen ordenados por tiempo). */
export function nearestIndex(points: readonly EquityPointView[], at: number): number {
  let lo = 0
  let hi = points.length - 1
  if (hi <= 0) return 0
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.at ?? 0) <= at) lo = mid
    else hi = mid
  }
  const a = points[lo]?.at ?? 0
  const b = points[hi]?.at ?? 0
  return Math.abs(at - a) <= Math.abs(b - at) ? lo : hi
}
