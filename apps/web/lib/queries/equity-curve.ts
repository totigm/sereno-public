import type { Db } from '@sereno/db'
import { startOfDayBA, type SessionKind } from '@sereno/shared'
import { equityNativeMs } from './equity-gap'
import { equitySeries, type EquityPointView } from './sql/equity'

/** La sesión de la curva: su id y su tipo (de él sale cada cuánto escribe puntos). */
export interface CurveSession {
  id: string
  kind: SessionKind
}

// La curva de Resumen (spec §11.1): cuatro rangos listos para cambiar sin otra
// consulta. "Hoy" va con todos los puntos (así se ven los huecos de 5 minutos); los
// rangos largos, de a un punto por tramo para no mandar 100.000 puntos a un SVG.

export const EQUITY_RANGES = ['hoy', '7d', '30d', 'todo'] as const
export type EquityRange = (typeof EQUITY_RANGES)[number]

export interface EquityCurve {
  from: number
  to: number
  /** Ancho del tramo de cada punto en ms; 0 si son todos los puntos. */
  bucketMs: number
  points: EquityPointView[]
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
// Unos 700 puntos alcanzan para el ancho de una pantalla de escritorio.
const TARGET_POINTS = 700

function bucketFor(spanMs: number): number {
  return Math.max(1, Math.ceil(spanMs / TARGET_POINTS / MINUTE_MS)) * MINUTE_MS
}

function rangeStart(range: EquityRange, startedAt: number, anchor: number): number {
  switch (range) {
    case 'hoy':
      return Math.max(startedAt, startOfDayBA(anchor))
    case '7d':
      return Math.max(startedAt, anchor - 7 * DAY_MS)
    case '30d':
      return Math.max(startedAt, anchor - 30 * DAY_MS)
    case 'todo':
      return startedAt
  }
}

/**
 * La curva de un rango terminando en `anchor` (ahora, o el final de una sesión
 * terminada). `startedAt` es desde cuándo hay curva: en un replay, el inicio del
 * período simulado.
 */
export async function equityCurve(db: Db, session: CurveSession, range: EquityRange, startedAt: number, anchor: number): Promise<EquityCurve> {
  const from = rangeStart(range, startedAt, anchor)
  const bucketMs = range === 'hoy' ? 0 : bucketFor(anchor - from)
  return { from, to: anchor, bucketMs, points: await equitySeries(db, session.id, from, anchor, bucketMs, equityNativeMs(session.kind)) }
}

/** Los cuatro rangos de Resumen. */
export async function equityCurves(db: Db, session: CurveSession, startedAt: number, anchor: number): Promise<Record<EquityRange, EquityCurve>> {
  const curves = await Promise.all(
    EQUITY_RANGES.map(async (range) => [range, await equityCurve(db, session, range, startedAt, anchor)] as const),
  )
  return Object.fromEntries(curves) as Record<EquityRange, EquityCurve>
}
