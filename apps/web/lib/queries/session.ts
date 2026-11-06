import { cache } from 'react'
import type { ReplayParams, SessionRow } from '@sereno/db'
import type { BinanceEnv, LearningOrigin, RealOffReason, RealStatus, SessionKind, SessionStatus } from '@sereno/shared'
import { repos } from '../db'

const DAY_MS = 86_400_000

export interface SessionView {
  id: string
  kind: SessionKind
  name: string
  status: SessionStatus
  capitalInicial: number
  baseBlindaje: number
  protegido: number
  learningOrigin: LearningOrigin
  startedAt: number
  endedAt: number | null
  /** Sólo replays: avance 0…1 y mensaje del bot ("Simulando · día 41 de 90"). */
  progreso: number | null
  mensaje: string | null
  replayParams: ReplayParams | null
  /**
   * El tramo de mercado que cubre. Un replay simula los `days` anteriores a cuando se
   * pidió (`startedAt`); una simulación en vivo va de `startedAt` a `endedAt` (null mientras sigue).
   */
  period: { from: number; to: number | null }
  /** Días que mide el veredicto: los del replay, o los transcurridos hasta `endedAt` o `now`. */
  days: number
  /** Sólo la sesión con plata real (`kind 'live'`): si opera y en qué entorno de Binance. */
  real: { status: RealStatus; env: BinanceEnv; offReason: RealOffReason | null } | null
}

export interface SessionContext {
  /** null en el primer uso (no hay simulación activa y no se pidió otra). */
  session: SessionView | null
  /** Una sesión activa (la de papel o la de plata real): acciones sobre el bot y datos en vivo. */
  isActive: boolean
  isReplay: boolean
  /** Simulación en vivo archivada: sólo lectura, copy en pasado. */
  isArchived: boolean
}

export function toSessionView(row: SessionRow, now: number): SessionView {
  const startedAt = row.startedAt.getTime()
  const endedAt = row.endedAt?.getTime() ?? null
  const replayDays = row.kind === 'replay' ? (row.replayParams?.days ?? null) : null
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    capitalInicial: row.capitalInicial,
    baseBlindaje: row.baseBlindaje,
    protegido: row.protegido,
    learningOrigin: row.learningOrigin,
    startedAt,
    endedAt,
    progreso: row.progreso,
    mensaje: row.mensaje,
    replayParams: row.replayParams ?? null,
    period: replayDays === null ? { from: startedAt, to: endedAt } : { from: startedAt - replayDays * DAY_MS, to: startedAt },
    days: replayDays ?? Math.max(0, ((endedAt ?? now) - startedAt) / DAY_MS),
    real: row.kind === 'live' && row.realStatus !== null && row.binanceEnv !== null ? { status: row.realStatus, env: row.binanceEnv, offReason: row.realOffReason } : null,
  }
}

export function contextOf(session: SessionView | null): SessionContext {
  return {
    session,
    isActive: session?.status === 'active',
    isReplay: session?.kind === 'replay',
    isArchived: session !== null && session.kind !== 'replay' && session.status === 'archived',
  }
}

/** Instante "actual" de una sesión: ahora si está activa; si terminó, su final. */
export function anchorOf(session: SessionView, now: number): number {
  if (session.status === 'active') return now
  return session.period.to ?? session.endedAt ?? now
}

/**
 * El contexto de las pantallas: sin id, la simulación en papel activa (rutas raíz); con
 * id, esa sesión (`/s/[sessionId]/…`), también la de plata real. Con un id que no existe,
 * `session` es null y la página decide (`notFound()`).
 */
export const getContext = cache(async (sessionId?: string): Promise<SessionContext> => {
  const row = sessionId === undefined ? await repos.sessions.getActive('paper_live') : await repos.sessions.get(sessionId)
  return contextOf(row ? toSessionView(row, Date.now()) : null)
})

/** La sesión pedida como vista, o null si no existe. */
export const getSessionView = cache(async (sessionId: string): Promise<SessionView | null> => {
  const row = await repos.sessions.get(sessionId)
  return row ? toSessionView(row, Date.now()) : null
})

/** Las dos sesiones activas: la simulación en papel y la de plata real (cada una puede faltar). */
export const getActiveSessions = cache(async (): Promise<{ paper: SessionView | null; real: SessionView | null }> => {
  const [paper, real] = await Promise.all([repos.sessions.getActive('paper_live'), repos.sessions.getActive('live')])
  const now = Date.now()
  return { paper: paper ? toSessionView(paper, now) : null, real: real ? toSessionView(real, now) : null }
})
