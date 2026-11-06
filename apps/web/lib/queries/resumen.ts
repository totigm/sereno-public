import { cache } from 'react'
import { z } from 'zod'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { db, repos } from '../db'
import type { LivePayload } from '../live/types'
import { getBooks, getLearning, getLive } from './books'
import { equityCurves, type EquityCurve, type EquityRange } from './equity-curve'
import { loadJournal, type JournalView } from './journal'
import { getTradeDetail, type TradeDetail } from './posiciones'
import { resumenReportView, type ResumenReportView } from './resumen-report'
import { anchorOf, getSessionView, type SessionView } from './session'
import { shieldedAt } from './sql/equity'
import { learningSources, type LearningSources } from './sql/sessions'
import { statsView, verdictView, type StatsView, type VerdictView } from './stats'

export interface ResumenData {
  session: SessionView
  /** Dato inicial de `LiveProvider` (y el estado final en una sesión terminada). */
  live: LivePayload
  equity: {
    ranges: Record<EquityRange, EquityCurve>
    /** 7 días en vivo; todo en un replay o una simulación archivada (spec §11.1). */
    defaultRange: EquityRange
  }
  verdict: VerdictView
  /** El reporte en contexto replay/archivada, en lugar del estado del bot. */
  stats: StatsView
  journal: JournalView
  /** Cuándo se disparó el blindaje vigente, para "Blindaste … el 20 de octubre". */
  shieldedAt: number | null
  /** El trade de `?trade=` (la hoja que se abre desde una abierta o desde el diario), si es de esta sesión. */
  trade: TradeDetail | null
  /** Lo que el bot dejó al terminar un replay (spec §9); null en una simulación o si no lo dejó. */
  report: ResumenReportView | null
}

// Lo que Resumen lee de la URL: la hoja de un trade (`?trade=<id>`). Lo inválido se ignora.
const ResumenQuerySchema = z.object({ trade: z.string().min(1).max(200).optional() })

export type ResumenQuery = z.infer<typeof ResumenQuerySchema>

export function parseResumenQuery(searchParams: Record<string, string | string[] | undefined>): ResumenQuery {
  const raw = searchParams.trade
  const parsed = ResumenQuerySchema.shape.trade.safeParse(Array.isArray(raw) ? raw[0] : raw)
  return parsed.success && parsed.data !== undefined ? { trade: parsed.data } : {}
}

export interface FirstRunData {
  learningSources: LearningSources
  defaults: { capital: number; protectPct: number; mode: Settings['mode'] }
}

/** Capital sugerido al crear la simulación (spec §7). */
export const SUGGESTED_CAPITAL = 1000

/** Resumen de una sesión; null si no existe. */
export const getResumenData = cache(async (sessionId: string, query: ResumenQuery = {}): Promise<ResumenData | null> => {
  const [session, live] = await Promise.all([getSessionView(sessionId), getLive(sessionId)])
  if (!session || !live) return null
  const anchor = anchorOf(session, live.now)
  const [books, learning, ranges, shielded, trade, report] = await Promise.all([
    getBooks(sessionId),
    getLearning(sessionId, session.startedAt),
    equityCurves(db, { id: sessionId, kind: session.kind }, session.period.from, anchor),
    session.protegido > 0 ? shieldedAt(db, sessionId) : null,
    query.trade === undefined ? null : getTradeDetail(session, query.trade, live),
    session.kind === 'replay' ? repos.sessions.getReport(sessionId) : null,
  ])
  const journal = await loadJournal(db, repos, { sessionId, anchor, theta: learning.state.params.theta, real: session.kind === 'live' })
  const unrealized = live.open.reduce((sum, p) => sum + (p.valuation.unrealized ?? 0), 0)

  return {
    session,
    live,
    equity: { ranges, defaultRange: session.status === 'active' ? '7d' : 'todo' },
    verdict: verdictView({
      real: books.real,
      shadowTrades: books.shadow.length,
      days: session.days,
      drawdown: books.drawdown,
      capitalInicial: session.capitalInicial,
      equity: live.ledger.saldo + unrealized,
      shadowEquity: live.equityLast?.shadowEquity ?? null,
      seed: sessionId,
    }),
    stats: statsView(books.real, books.drawdown),
    journal,
    shieldedAt: shielded,
    trade,
    report: report === null ? null : resumenReportView(report, learning.state.params.theta),
  }
})

/** Primer uso: el formulario de dos pasos (más el tercero si hay replays con aprendizaje). */
export async function getFirstRunData(): Promise<FirstRunData> {
  return {
    learningSources: await learningSources(db),
    defaults: { capital: SUGGESTED_CAPITAL, protectPct: DEFAULT_SETTINGS.capital.protectPct, mode: DEFAULT_SETTINGS.mode },
  }
}
