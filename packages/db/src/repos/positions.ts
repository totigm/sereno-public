import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, ne, sql, type SQL } from 'drizzle-orm'
import type { ClosedPosition, Position, Side, SignalId } from '@sereno/core'
import type { PositionEventKind } from '@sereno/shared'
import type { Db } from '../client'
import { positionEvents, positions, sessions } from '../schema'
import { SessionArchivedError } from './errors'
import { excluded } from './sql-helpers'
import {
  closedValues,
  openValues,
  toClosedRecord,
  toPositionRecord,
  type ClosedPositionRecord,
  type PositionRecord,
  type PositionRow,
} from './position-rows'

export type PositionEventRow = typeof positionEvents.$inferSelect

export interface PositionWriteOptions {
  // Por defecto, las señales que llegaron sin valor.
  missingSignals?: SignalId[]
  // Milisegundos entre el cierre de la vela y la orden de entrada.
  latencyMs?: number | null
}

export interface ClosedFilters {
  symbol?: string
  side?: Side
  // Mismo criterio que las estadísticas: ganado si pnlNet > 0, perdido si < 0.
  result?: 'won' | 'lost'
  liquidated?: boolean
  shadow?: boolean
  // Instantes en ms sobre `closedAt`: [from, to).
  from?: number
  to?: number
}

export interface Paging {
  limit: number
  offset?: number
}

export interface PositionEventInput {
  kind: PositionEventKind
  payload: Record<string, unknown>
  at: number
}

// Lo que cambia mientras una posición está abierta (stops, trailing, órdenes,
// costos, cierres parciales). Lo que la identifica no se reescribe nunca.
const MUTABLE_WHILE_OPEN = [
  'qty',
  'margin',
  'notional',
  'stopPrice',
  'takeProfitPrice',
  'liquidationPrice',
  'trailingActive',
  'bestPrice',
  'stopOrderId',
  'tpOrderId',
  'fees',
  'funding',
] as const satisfies readonly (keyof PositionRow)[]

const SET_ON_CLOSE = [
  ...MUTABLE_WHILE_OPEN,
  'exitPrice',
  'closedAt',
  'closeReason',
  'closePhrase',
  'pnlGross',
  'pnlNet',
  'rMultiple',
  'costs',
] as const satisfies readonly (keyof PositionRow)[]

// Sólo se reescribe una abierta de la misma sesión: un id repetido en otra
// sesión (un replay con ids deterministas) nunca pisa una fila ajena.
const writableOpen = sql`${isNull(positions.closedAt)} and ${eq(positions.sessionId, excluded(positions.sessionId))}`

function fromExcluded(keys: readonly (keyof PositionRow)[]): Record<string, SQL> {
  return Object.fromEntries(keys.map((k) => [k, excluded(positions[k])]))
}

// Escribe en la misma transacción que bloquea la sesión `FOR SHARE`: si se está
// archivando (el archivo la tiene `FOR UPDATE`), espera a que termine y ve el
// estado final. El chequeo de la clave foránea no alcanza: deja pasar la escritura
// a una sesión que se archivó mientras esperaba.
async function inWritableSession<T>(db: Db, sessionId: string, write: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId)).for('share')
    if (session?.status === 'archived') throw new SessionArchivedError(sessionId)
    return write(tx)
  })
}

function closedWhere(sessionId: string, f: ClosedFilters): SQL | undefined {
  return and(
    eq(positions.sessionId, sessionId),
    isNotNull(positions.closedAt),
    eq(positions.shadow, f.shadow ?? false),
    f.symbol === undefined ? undefined : eq(positions.symbol, f.symbol),
    f.side === undefined ? undefined : eq(positions.side, f.side),
    f.result === 'won' ? gt(positions.pnlNet, 0) : f.result === 'lost' ? lt(positions.pnlNet, 0) : undefined,
    f.liquidated === undefined
      ? undefined
      : f.liquidated
        ? eq(positions.closeReason, 'liquidation')
        : ne(positions.closeReason, 'liquidation'),
    f.from === undefined ? undefined : gte(positions.closedAt, new Date(f.from)),
    f.to === undefined ? undefined : lt(positions.closedAt, new Date(f.to)),
  )
}

export function createPositionsRepo(db: Db) {
  return {
    // Alta o actualización de una abierta. Sobre una ya cerrada (o de otra
    // sesión) no hace nada: un evento atrasado nunca reabre un trade. Devuelve si
    // escribió; con la sesión archivada lanza `SessionArchivedError`.
    async upsertOpen(sessionId: string, position: Position, opts: PositionWriteOptions = {}): Promise<boolean> {
      return inWritableSession(db, sessionId, async (tx) => {
        const written = await tx
          .insert(positions)
          .values(openValues(sessionId, position, opts))
          .onConflictDoUpdate({ target: positions.id, set: fromExcluded(MUTABLE_WHILE_OPEN), setWhere: writableOpen })
          .returning({ id: positions.id })
        return written.length > 0
      })
    },

    // Cierra la posición (o la da de alta ya cerrada si abrió y cerró en el mismo
    // ciclo). Idempotente: si ya estaba cerrada (o es de otra sesión) devuelve false
    // y no la toca; con la sesión archivada lanza `SessionArchivedError`.
    async close(sessionId: string, closed: ClosedPosition, phrase: string, opts: PositionWriteOptions = {}): Promise<boolean> {
      const values = { ...openValues(sessionId, closed, opts), ...closedValues(closed, phrase) }
      return inWritableSession(db, sessionId, async (tx) => {
        const written = await tx
          .insert(positions)
          .values(values)
          .onConflictDoUpdate({ target: positions.id, set: fromExcluded(SET_ON_CLOSE), setWhere: writableOpen })
          .returning({ id: positions.id })
        return written.length > 0
      })
    },

    // Alta de una posición que el bot abrió en Binance y no llegó a guardar (se cayó entre la
    // orden y el guardado): la fila y su evento `open` (el fill de Binance, sin costos de
    // spread ni slippage medidos) en una transacción. Nunca pisa una fila que ya exista:
    // devuelve false y no escribe nada.
    async insertAdopted(sessionId: string, position: Position): Promise<boolean> {
      return inWritableSession(db, sessionId, async (tx) => {
        const written = await tx.insert(positions).values(openValues(sessionId, position)).onConflictDoNothing({ target: positions.id }).returning({ id: positions.id })
        if (written.length === 0) return false
        await tx.insert(positionEvents).values({
          positionId: position.id,
          kind: 'open',
          payload: { price: position.entryPrice, qty: position.qty, fee: position.feesPaid, spreadCost: 0, slippageCost: 0, adopted: true },
          at: new Date(position.openedAt),
        })
        return true
      })
    },

    async listOpen(sessionId: string, { shadow = false }: { shadow?: boolean } = {}): Promise<PositionRecord[]> {
      const rows = await db
        .select()
        .from(positions)
        .where(and(eq(positions.sessionId, sessionId), isNull(positions.closedAt), eq(positions.shadow, shadow)))
        .orderBy(asc(positions.openedAt), asc(positions.id))
      return rows.map(toPositionRecord)
    },

    // Las más recientes primero. Sin `paging`, todas (las estadísticas las usan enteras).
    async listClosed(
      sessionId: string,
      filters: ClosedFilters = {},
      paging?: Paging,
    ): Promise<{ items: ClosedPositionRecord[]; hasMore: boolean }> {
      const query = db
        .select()
        .from(positions)
        .where(closedWhere(sessionId, filters))
        .orderBy(desc(positions.closedAt), desc(positions.id))
      if (!paging) return { items: (await query).map(toClosedRecord), hasMore: false }
      // Se pide uno de más para saber si hay otra página sin contar todo.
      const rows = await query.limit(paging.limit + 1).offset(paging.offset ?? 0)
      return { items: rows.slice(0, paging.limit).map(toClosedRecord), hasMore: rows.length > paging.limit }
    },

    async addEvent(positionId: string, event: PositionEventInput): Promise<void> {
      await db.insert(positionEvents).values({ positionId, kind: event.kind, payload: event.payload, at: new Date(event.at) })
    },

    // Línea de tiempo de una posición, en orden.
    async listEvents(positionId: string): Promise<PositionEventRow[]> {
      return db
        .select()
        .from(positionEvents)
        .where(eq(positionEvents.positionId, positionId))
        .orderBy(asc(positionEvents.at), asc(positionEvents.id))
    },
  }
}

export type PositionsRepo = ReturnType<typeof createPositionsRepo>
