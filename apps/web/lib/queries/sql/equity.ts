import { and, asc, desc, eq, gt, gte, lte, sql } from 'drizzle-orm'
import { equitySnapshots, type Db } from '@sereno/db'
import { EQUITY_GAP_MS } from '../equity-gap'
import { asNullableNumber, asNumber, epochMs, interval } from './fields'

const ofSession = (sessionId: string) => eq(equitySnapshots.sessionId, sessionId)

export interface EquityAt {
  at: number
  equity: number
  shadowEquity: number | null
}

/** El último punto de la curva en o antes de `t`; null si la curva empieza después. */
export async function equityAt(db: Db, sessionId: string, t: number): Promise<EquityAt | null> {
  const [row] = await db
    .select({ at: equitySnapshots.at, equity: equitySnapshots.equity, shadowEquity: equitySnapshots.shadowEquity })
    .from(equitySnapshots)
    .where(and(ofSession(sessionId), lte(equitySnapshots.at, new Date(t))))
    .orderBy(desc(equitySnapshots.at), desc(equitySnapshots.id))
    .limit(1)
  return row ? { ...row, at: row.at.getTime() } : null
}

export interface DrawdownView {
  /** Peor caída desde un pico previo, en fracción del pico (0,12 = 12%). */
  pct: number
  peakAt: number | null
  troughAt: number | null
  /** Resolución de la curva con que se midió: por minuto si la sesión tiene puntos por minuto. */
  resolution: 'minute' | 'event' | null
}

/**
 * El drawdown máximo de la curva entera, calculado en la base: el mismo criterio que
 * `maxDrawdown` de core (pico estricto, picos ≤ 0 no cuentan) sin traer los ~130.000
 * puntos de 90 días.
 */
export async function maxDrawdown(db: Db, sessionId: string): Promise<DrawdownView> {
  const running = db
    .select({
      at: equitySnapshots.at,
      kind: equitySnapshots.kind,
      equity: equitySnapshots.equity,
      peak: sql<number>`max(${equitySnapshots.equity}) over (order by ${equitySnapshots.at}, ${equitySnapshots.id} rows unbounded preceding)`.as(
        'peak',
      ),
    })
    .from(equitySnapshots)
    .where(ofSession(sessionId))
    .as('running')
  const fall = sql<number>`case when ${running.peak} > 0 then (${running.peak} - ${running.equity}) / ${running.peak} else 0 end`
  const [worst] = await db
    .select({
      pct: asNumber(fall),
      troughAt: epochMs(sql`${running.at}`),
      peak: asNumber(sql`${running.peak}`),
      minute: sql<boolean>`bool_or(${running.kind} = 'minute') over ()`,
    })
    .from(running)
    .orderBy(desc(fall), asc(running.at))
    .limit(1)
  if (!worst) return { pct: 0, peakAt: null, troughAt: null, resolution: null }
  const resolution = worst.minute ? 'minute' : 'event'
  if (!(worst.pct > 0) || worst.troughAt === null) return { pct: 0, peakAt: null, troughAt: null, resolution }

  const [peak] = await db
    .select({ at: epochMs(sql`min(${equitySnapshots.at})`) })
    .from(equitySnapshots)
    .where(and(ofSession(sessionId), eq(equitySnapshots.equity, worst.peak), lte(equitySnapshots.at, new Date(worst.troughAt))))
  return { pct: worst.pct, peakAt: peak?.at ?? null, troughAt: worst.troughAt, resolution }
}

export interface EquityPointView {
  at: number
  equity: number
  saldo: number
  shadowEquity: number | null
  /**
   * Hubo un hueco antes de este punto (más de 5 minutos sobre el tramo y la resolución
   * de la sesión): el gráfico lo dibuja punteado.
   */
  gapBefore: boolean
}

/**
 * La curva en [from, to], de a un punto por tramo de `bucketMs` (el último de cada
 * tramo, como el cierre de una vela); con `bucketMs = 0`, todos los puntos. `nativeMs`
 * es cada cuánto escribe la sesión (`equityNativeMs`): un replay va de a 15 minutos y
 * eso no es un hueco.
 */
export async function equitySeries(
  db: Db,
  sessionId: string,
  from: number,
  to: number,
  bucketMs: number,
  nativeMs: number,
): Promise<EquityPointView[]> {
  const inRange = and(ofSession(sessionId), gte(equitySnapshots.at, new Date(from)), lte(equitySnapshots.at, new Date(to)))
  const raw =
    bucketMs <= 0
      ? await db
          .select({
            at: epochMs(sql`${equitySnapshots.at}`),
            equity: equitySnapshots.equity,
            saldo: equitySnapshots.saldo,
            shadowEquity: equitySnapshots.shadowEquity,
          })
          .from(equitySnapshots)
          .where(inRange)
          .orderBy(asc(equitySnapshots.at), asc(equitySnapshots.id))
      : await bucketed(db, inRange, from, bucketMs)

  const points: EquityPointView[] = []
  let prev: number | null = null
  for (const r of raw) {
    if (r.at === null) continue
    points.push({ ...r, at: r.at, gapBefore: prev !== null && r.at - prev > bucketMs + nativeMs + EQUITY_GAP_MS })
    prev = r.at
  }
  return points
}

function bucketed(db: Db, where: ReturnType<typeof and>, origin: number, bucketMs: number) {
  const bucket = sql`date_bin(${interval(bucketMs)}, ${equitySnapshots.at}, ${new Date(origin).toISOString()}::timestamptz)`
  const last = (column: typeof equitySnapshots.equity | typeof equitySnapshots.saldo | typeof equitySnapshots.shadowEquity) =>
    sql`(array_agg(${column} order by ${equitySnapshots.at} desc, ${equitySnapshots.id} desc))[1]`
  return db
    .select({
      at: epochMs(sql`max(${equitySnapshots.at})`),
      equity: asNumber(last(equitySnapshots.equity)),
      saldo: asNumber(last(equitySnapshots.saldo)),
      shadowEquity: asNullableNumber(last(equitySnapshots.shadowEquity)),
    })
    .from(equitySnapshots)
    .where(where)
    .groupBy(bucket)
    // Por `max(at)` y no por el tramo: con parámetros, Postgres no reconoce que la
    // expresión del ORDER BY es la misma del GROUP BY.
    .orderBy(sql`max(${equitySnapshots.at})`)
}

/**
 * Cuándo se disparó el blindaje vigente: el primer punto con `protegido > 0` después
 * del último sin blindaje. Null si no está blindado o la curva no lo registró.
 */
export async function shieldedAt(db: Db, sessionId: string): Promise<number | null> {
  const [lastUnshielded] = await db
    .select({ at: equitySnapshots.at })
    .from(equitySnapshots)
    .where(and(ofSession(sessionId), eq(equitySnapshots.protegido, 0)))
    .orderBy(desc(equitySnapshots.at))
    .limit(1)
  const [first] = await db
    .select({ at: epochMs(sql`min(${equitySnapshots.at})`) })
    .from(equitySnapshots)
    .where(
      and(
        ofSession(sessionId),
        gt(equitySnapshots.protegido, 0),
        lastUnshielded ? gt(equitySnapshots.at, lastUnshielded.at) : undefined,
      ),
    )
  return first?.at ?? null
}
