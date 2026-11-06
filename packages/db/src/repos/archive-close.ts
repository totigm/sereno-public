import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { marketSnapshot, positions, settings, symbols, type sessions } from '../schema'
import { defaultHalfSpread, exitAtMark, type ExitCosts } from './archive-exit'
import { createPositionsRepo } from './positions'
import { toPositionRecord, type PositionRecord } from './position-rows'
import { millis } from './sql-helpers'

export interface ArchiveClose {
  id: string
  symbol: string
  shadow: boolean
  exitPrice: number
  pnlNet: number
}

interface PlannedExit {
  position: PositionRecord
  mark: number
  costs: ExitCosts
}

// Lo que se va a cerrar al archivar, decidido antes de tocar nada. `markAt` es
// el instante del precio de marca con que se valúa (null si no hay abiertas que
// valuar, o si no hay snapshot).
export type ArchivePlan =
  | { fresh: false; markAt: Date | null }
  | { fresh: true; markAt: Date | null; exits: PlannedExit[]; leftOpen: string[] }

const PHRASE = 'Cerrada al archivar la simulación, al último precio de marca.'

// Las abiertas de la sesión, reales y sombra.
const openIn = (sessionId: string) => and(eq(positions.sessionId, sessionId), isNull(positions.closedAt))

// "Nueva simulación" cierra las abiertas al precio actual (spec §11.1): el que
// dejó el bot en `market_snapshot`. Si ese snapshot es más viejo que
// `maxMarkAgeMs` (contra el reloj de la base), el precio ya no es "el actual" y
// no se cierra nada: quien llama decide si avisa o archiva sin cerrar. Con un
// snapshot al día, una moneda sin precio o degradada (su marca dejó de llegar)
// no se cierra con un precio inventado: queda abierta y se informa.
//
// Las abiertas se leen `FOR UPDATE`. El repo de posiciones espera al bloqueo de
// la sesión, pero un `UPDATE` de la fila que no cambia `session_id` no lo toma:
// sin este bloqueo, un funding o un cierre parcial confirmado entre el plan y el
// cierre quedaría pisado con los valores viejos del plan.
export async function planArchiveCloses(
  tx: Db,
  session: Pick<typeof sessions.$inferSelect, 'id' | 'settingsSnapshot'>,
  maxMarkAgeMs: number,
): Promise<ArchivePlan> {
  const open = (
    await tx
      .select()
      .from(positions)
      .where(openIn(session.id))
      .orderBy(asc(positions.id))
      .for('update')
  ).map(toPositionRecord)
  if (open.length === 0) return { fresh: true, markAt: null, exits: [], leftOpen: [] }

  const [snapshot] = await tx
    .select({
      symbols: marketSnapshot.symbols,
      updatedAt: marketSnapshot.updatedAt,
      fresh: sql<boolean>`${marketSnapshot.updatedAt} >= now() - ${millis(maxMarkAgeMs)}`,
    })
    .from(marketSnapshot)
    .where(eq(marketSnapshot.sessionId, session.id))
  if (!snapshot?.fresh) return { fresh: false, markAt: snapshot?.updatedAt ?? null }

  const marks = new Map(snapshot.symbols.filter((s) => s.state !== 'degraded').map((s) => [s.symbol, s.markPrice]))
  const [current] = await tx.select({ config: settings.config }).from(settings).where(eq(settings.sessionId, session.id))
  const { risk } = current?.config ?? session.settingsSnapshot
  const spreads = new Map(
    (
      await tx
        .select({ symbol: symbols.symbol, observedSpread: symbols.observedSpread })
        .from(symbols)
        .where(inArray(symbols.symbol, [...new Set(open.map((p) => p.symbol))]))
    ).map((s) => [s.symbol, s.observedSpread]),
  )

  const exits: PlannedExit[] = []
  const leftOpen: string[] = []
  for (const position of open) {
    const mark = marks.get(position.symbol)
    if (mark === undefined || !(mark > 0)) {
      leftOpen.push(position.id)
      continue
    }
    const halfSpreadRate = spreads.get(position.symbol) ?? defaultHalfSpread(position.symbol)
    exits.push({ position, mark, costs: { takerFeeRate: risk.takerFeeRate, slippageRate: risk.slippageRate, halfSpreadRate } })
  }
  return { fresh: true, markAt: snapshot.updatedAt, exits, leftOpen }
}

// Las abiertas que quedan en la sesión, en el mismo orden que el plan.
export async function listOpenIds(tx: Db, sessionId: string): Promise<string[]> {
  const rows = await tx.select({ id: positions.id }).from(positions).where(openIn(sessionId)).orderBy(asc(positions.id))
  return rows.map((r) => r.id)
}

// Escribe los cierres del plan, con su evento, al instante del archivo. Ninguna fila
// del plan pudo cerrarse en el medio: el plan las leyó `FOR UPDATE` en esta misma
// transacción y toda escritura del repo de posiciones espera el bloqueo de la sesión,
// así que `close` siempre escribe y no hay cierre ajeno que respetar. Si igual no
// escribiera, el invariante se rompió: se lanza (y la transacción vuelve atrás) antes
// que agregar un evento de cierre e informar cerrada una posición que no se cerró.
export async function applyArchiveCloses(
  tx: Db,
  sessionId: string,
  plan: Extract<ArchivePlan, { fresh: true }>,
  closedAt: number,
): Promise<{ closed: ArchiveClose[]; leftOpen: string[] }> {
  const repo = createPositionsRepo(tx)
  const closed: ArchiveClose[] = []
  for (const { position: p, mark, costs } of plan.exits) {
    const c = exitAtMark(p, mark, costs, closedAt)
    const written = await repo.close(sessionId, c, PHRASE, { missingSignals: p.missingSignals, latencyMs: p.latencyMs })
    if (!written) throw new Error(`No pude cerrar ${p.id} al archivar la simulación: ya no estaba abierta en la sesión ${sessionId}`)
    await repo.addEvent(p.id, {
      kind: 'close',
      payload: { reason: c.closeReason, markPrice: mark, exitPrice: c.exitPrice, pnlNet: c.pnlNet },
      at: closedAt,
    })
    closed.push({ id: p.id, symbol: p.symbol, shadow: p.shadow, exitPrice: c.exitPrice, pnlNet: c.pnlNet })
  }
  return { closed, leftOpen: plan.leftOpen }
}
