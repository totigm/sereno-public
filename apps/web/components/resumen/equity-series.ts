import { startOfDayBA } from '@/lib/format'
import type { EquityCurve, EquityRange } from '@/lib/queries/equity-curve'
import type { EquityPointView } from '@/lib/queries/sql/equity'

// La curva que se dibuja: la del servidor más el punto de ahora, así su final coincide con
// el titular aunque la página se haya cargado hace un rato. Y la tabla equivalente.

export interface LivePoint {
  at: number
  equity: number
  saldo: number
  shadowEquity: number | null
}

export interface DrawnCurve {
  from: number
  to: number
  points: EquityPointView[]
}

/**
 * Suma el punto de ahora si es más nuevo que el último. No lleva `gapBefore`: entre la
 * carga de la página y ahora hubo puntos, sólo que todavía no se pidieron. A un rango
 * sin puntos no se le agrega: un punto suelto no es una curva.
 */
export function withLivePoint(curve: EquityCurve, live: LivePoint | null): DrawnCurve {
  const last = curve.points.at(-1)
  if (live === null || !last || live.at <= last.at) return { from: curve.from, to: curve.to, points: curve.points }
  return { from: curve.from, to: Math.max(curve.to, live.at), points: [...curve.points, { ...live, gapBefore: false }] }
}

/** El color de la curva: para dónde fue en el rango que se ve, como el signo de su variación. */
export function rangeTone(points: readonly EquityPointView[]): 'gain' | 'loss' {
  const first = points[0]
  const last = points.at(-1)
  return first && last && last.equity < first.equity ? 'loss' : 'gain'
}

export interface ValueRow {
  /** Inicio del día (o de la hora, en "hoy"). */
  at: number
  /** El último punto del tramo, como el cierre de una vela. */
  point: EquityPointView
}

const HOUR_MS = 3_600_000

/** La tabla equivalente (spec §11.2): el cierre de cada día, o de cada hora en "hoy"; lo más nuevo primero. */
export function valueRows(points: readonly EquityPointView[], range: EquityRange): ValueRow[] {
  const keyOf = range === 'hoy' ? (at: number) => Math.floor(at / HOUR_MS) * HOUR_MS : startOfDayBA
  const rows = new Map<number, EquityPointView>()
  for (const p of points) rows.set(keyOf(p.at), p)
  return [...rows.entries()].reverse().map(([at, point]) => ({ at, point }))
}
