import { and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, lte, or, sql } from 'drizzle-orm'
import type { Decision } from '@sereno/core'
import type { Db } from '../client'
import { decisions, sessions } from '../schema'
import { decisionValues } from './decision-rows'
import { chunks } from './sql-helpers'

type DecisionRow = typeof decisions.$inferSelect
export type DecisionRecord = Omit<DecisionRow, 'candleCloseTime'> & { candleCloseTime: number }

export interface ForwardReturns {
  forwardReturn4h: number | null
  forwardReturn24h: number | null
}

export interface ForwardReturnUpdate {
  id: number
  forwardReturn4h?: number
  forwardReturn24h?: number
}

export interface JournalQuery {
  // Rango en ms sobre el cierre de la vela: [from, to).
  from: number
  to?: number
  // |S'| mínimo para que valga contarlo: θ − 0,1 (spec §11.1).
  minAbsSPrime: number
  // A lo sumo una por moneda en esta ventana; 4 horas por defecto.
  minGapMs?: number
  // Las N más nuevas (después de espaciar); sin límite, todas.
  limit?: number
}

// La última pendiente que se vio: la página siguiente empieza después (por cierre y por id).
export interface PendingCursor {
  candleCloseTime: number
  id: number
}

export interface PendingForwardQuery {
  limit?: number
  // Más vieja que esto se da por perdida (sus velas no llegaron); 7 días por defecto.
  maxAgeMs?: number
  after?: PendingCursor
}

const HOUR_MS = 3_600_000
const FOUR_HOURS_MS = 4 * HOUR_MS
const DAY_MS = 24 * HOUR_MS
const PENDING_HORIZON_MS = 7 * DAY_MS

type SpacingKey = { id: number; symbol: string; candleCloseTime: number }

function toRecord(r: DecisionRow): DecisionRecord {
  return { ...r, candleCloseTime: r.candleCloseTime.getTime() }
}

// De cada moneda, la primera de cada ventana de `gapMs`, recorriendo en orden.
function spaced(rows: readonly SpacingKey[], gapMs: number): SpacingKey[] {
  const lastKept = new Map<string, number>()
  return rows.filter((r) => {
    const prev = lastKept.get(r.symbol)
    if (prev !== undefined && r.candleCloseTime - prev < gapMs) return false
    lastKept.set(r.symbol, r.candleCloseTime)
    return true
  })
}

export function createDecisionsRepo(db: Db) {
  return {
    // Un lote por cierre de vela (o miles en un replay). Devuelve cuántas guardó.
    // `forward` da los retornos de cada una cuando ya se conocen (un replay).
    async insertBatch(sessionId: string, batch: readonly Decision[], forward?: (d: Decision) => ForwardReturns): Promise<number> {
      let inserted = 0
      for (const part of chunks(batch, 2000)) {
        const rows = await db
          .insert(decisions)
          .values(part.map((d) => ({ ...decisionValues(sessionId, d), ...forward?.(d) })))
          .returning({ id: decisions.id })
        inserted += rows.length
      }
      return inserted
    },

    async range(sessionId: string, from: number, to: number, { symbol }: { symbol?: string } = {}): Promise<DecisionRecord[]> {
      const rows = await db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.sessionId, sessionId),
            gte(decisions.candleCloseTime, new Date(from)),
            lt(decisions.candleCloseTime, new Date(to)),
            symbol === undefined ? undefined : eq(decisions.symbol, symbol),
          ),
        )
        .orderBy(asc(decisions.candleCloseTime), asc(decisions.id))
      return rows.map(toRecord)
    },

    // Las que ya pueden tener retorno a 4 h o a 24 h y todavía no lo tienen, en
    // el orden en que el job las va a recorrer. Las de más de `maxAgeMs` no se
    // listan: si sus velas no llegaron (una moneda deslistada), seguirían
    // ocupando el `limit` en cada corrida hasta la limpieza de 30 días.
    async listPendingForwardReturns(
      sessionId: string,
      now: number,
      { limit = 5000, maxAgeMs = PENDING_HORIZON_MS, after }: PendingForwardQuery = {},
    ): Promise<DecisionRecord[]> {
      const rows = await db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.sessionId, sessionId),
            gt(decisions.candleCloseTime, new Date(now - maxAgeMs)),
            after === undefined
              ? undefined
              : or(
                  gt(decisions.candleCloseTime, new Date(after.candleCloseTime)),
                  and(eq(decisions.candleCloseTime, new Date(after.candleCloseTime)), gt(decisions.id, after.id)),
                ),
            or(
              and(isNull(decisions.forwardReturn4h), lte(decisions.candleCloseTime, new Date(now - FOUR_HOURS_MS))),
              and(isNull(decisions.forwardReturn24h), lte(decisions.candleCloseTime, new Date(now - DAY_MS))),
            ),
          ),
        )
        .orderBy(asc(decisions.candleCloseTime), asc(decisions.id))
        .limit(limit)
      return rows.map(toRecord)
    },

    // Rellena los retornos en una sentencia por lote. Un valor que no viene no
    // borra el que ya estaba. Devuelve cuántas filas tocó.
    async fillForwardReturns(updates: readonly ForwardReturnUpdate[]): Promise<number> {
      let updated = 0
      for (const part of chunks(updates, 5000)) {
        const values = sql.join(
          part.map(
            (u) =>
              sql`(${u.id}::bigint, ${u.forwardReturn4h ?? null}::double precision, ${u.forwardReturn24h ?? null}::double precision)`,
          ),
          sql`, `,
        )
        const rows = await db
          .update(decisions)
          .set({
            forwardReturn4h: sql`coalesce(v.r4, ${decisions.forwardReturn4h})`,
            forwardReturn24h: sql`coalesce(v.r24, ${decisions.forwardReturn24h})`,
          })
          .from(sql`(values ${values}) as v(id, r4, r24)`)
          .where(sql`${decisions.id} = v.id`)
          .returning({ id: decisions.id })
        updated += rows.length
      }
      return updated
    },

    // Candidatas a "esperé" en el diario (spec §11.1): bloqueadas por un filtro
    // con |S'| cerca del umbral, a lo sumo una por moneda cada 4 horas. Las más
    // recientes primero. El espaciado depende de todo el tramo desde `from`, así
    // que primero se recorren sólo las claves y después se traen completas (con
    // sus señales) únicamente las que quedan.
    async listJournalCandidates(sessionId: string, q: JournalQuery): Promise<DecisionRecord[]> {
      const keys = await db
        .select({ id: decisions.id, symbol: decisions.symbol, candleCloseTime: decisions.candleCloseTime })
        .from(decisions)
        .where(
          and(
            eq(decisions.sessionId, sessionId),
            like(decisions.action, 'blocked:%'),
            gte(sql`abs(${decisions.sPrime})`, q.minAbsSPrime),
            gte(decisions.candleCloseTime, new Date(q.from)),
            q.to === undefined ? undefined : lt(decisions.candleCloseTime, new Date(q.to)),
          ),
        )
        .orderBy(asc(decisions.candleCloseTime), asc(decisions.id))
      const kept = spaced(
        keys.map((k) => ({ ...k, candleCloseTime: k.candleCloseTime.getTime() })),
        q.minGapMs ?? FOUR_HOURS_MS,
      ).reverse()
      const ids = (q.limit === undefined ? kept : kept.slice(0, q.limit)).map((k) => k.id)
      const out: DecisionRecord[] = []
      for (const part of chunks(ids, 5000)) {
        const rows = await db
          .select()
          .from(decisions)
          .where(inArray(decisions.id, part))
          .orderBy(desc(decisions.candleCloseTime), desc(decisions.id))
        out.push(...rows.map(toRecord))
      }
      return out
    },

    // Limpieza diaria (spec §10): en vivo se guardan 30 días; los replays quedan
    // completos. Devuelve cuántas borró.
    async pruneOlderThan(cutoff: number): Promise<number> {
      const live = db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.kind, ['paper_live', 'live']))
      const deleted = await db
        .delete(decisions)
        .where(and(lt(decisions.candleCloseTime, new Date(cutoff)), inArray(decisions.sessionId, live)))
        .returning({ id: decisions.id })
      return deleted.length
    },
  }
}

export type DecisionsRepo = ReturnType<typeof createDecisionsRepo>
