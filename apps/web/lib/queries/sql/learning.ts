import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { SIGNAL_IDS, type SignalId } from '@sereno/core'
import { MIN_RELIABILITY_SAMPLE } from '@sereno/core/src/learning/reliability'
import { decisions, learningLog, type Db, type LearningLogRecord } from '@sereno/db'
import { rowsOf } from './fields'

export interface ReliabilityView {
  /** Spearman entre el valor de la señal y el retorno a 4 h; null con menos de 10 pares o sin varianza. */
  rho: number | null
  n: number
}

/**
 * La fiabilidad de cada señal (spec §8.1) sobre las decisiones de [from, to) con
 * retorno a 4 h: la misma correlación de rangos de `reliabilityDetail` de core
 * (Pearson sobre rangos promedio en los empates), calculada en la base para no
 * traer ~84.000 decisiones de 28 días con sus señales.
 */
export async function signalReliability(db: Db, sessionId: string, from: number, to: number): Promise<Record<SignalId, ReliabilityView>> {
  // `sig` y no `s`: `decisions` tiene su propia columna `s` y la taparía.
  const result = await db.execute(sql`
    with pairs as (
      select sig->>'id' as id, (sig->>'value')::double precision as x, ${decisions.forwardReturn4h} as y
      from ${decisions}, jsonb_array_elements(${decisions.signals}) as sig
      where ${decisions.sessionId} = ${sessionId}
        and ${decisions.candleCloseTime} >= ${new Date(from).toISOString()}::timestamptz
        and ${decisions.candleCloseTime} < ${new Date(to).toISOString()}::timestamptz
        and ${decisions.forwardReturn4h} is not null
        and jsonb_typeof(sig->'value') = 'number'
    ),
    ranked as (
      select id,
        rank() over (partition by id order by x) + (count(*) over (partition by id, x) - 1) / 2.0 as rx,
        rank() over (partition by id order by y) + (count(*) over (partition by id, y) - 1) / 2.0 as ry
      from pairs
    )
    select id, corr(rx, ry) as rho, count(*) as n from ranked group by id
  `)
  const byId = new Map(rowsOf<{ id: string; rho: number | string | null; n: number | string }>(result).map((r) => [r.id, r]))
  const out = {} as Record<SignalId, ReliabilityView>
  for (const id of SIGNAL_IDS) {
    const row = byId.get(id)
    const n = Number(row?.n ?? 0)
    const rho = row?.rho === null || row?.rho === undefined ? null : Number(row.rho)
    out[id] = { rho: n >= MIN_RELIABILITY_SAMPLE && rho !== null && Number.isFinite(rho) ? rho : null, n }
  }
  return out
}

/** Las últimas entradas del diario de aprendizaje de ciertos tipos (parámetros adoptados o rechazados). */
export async function learningLogOfKinds(db: Db, sessionId: string, kinds: readonly string[], limit: number): Promise<LearningLogRecord[]> {
  const rows = await db
    .select()
    .from(learningLog)
    .where(and(eq(learningLog.sessionId, sessionId), inArray(learningLog.kind, [...kinds])))
    .orderBy(desc(learningLog.at), desc(learningLog.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    at: r.at.getTime(),
    kind: r.kind,
    symbol: r.symbol,
    signal: r.signal,
    message: r.message,
    sampleSize: r.sampleSize,
    before: r.before ?? null,
    after: r.after ?? null,
  }))
}
