import { cache } from 'react'
import { SIGNAL_IDS, type LearningState, type SignalId } from '@sereno/core'
import { isPenalized, symbolConfidence, symbolMultiplier } from '@sereno/core/src/learning/confidence'
import { compareShadow, type ShadowComparison } from '@sereno/core/src/learning/shadow'
import type { LearningChange } from '@sereno/core/src/learning/state'
import { phraseLearning, SIGNAL_NAMES } from '@sereno/core/src/journal/phrases'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { ClosedPositionRecord, LearningLogRecord } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { db, repos } from '../db'
import type { CommandView, LivePayload } from '../live/types'
import { getBooks, getLearning, getLive } from './books'
import { equityCurve, type EquityCurve } from './equity-curve'
import { toCommandView } from './live'
import { anchorOf, getSessionView, toSessionView, type SessionView } from './session'
import { equityAt } from './sql/equity'
import { readLedgerTotalsBySession, saldoOf } from './sql/ledger'
import { learningLogOfKinds, signalReliability, type ReliabilityView } from './sql/learning'

const DAY_MS = 86_400_000
const RELIABILITY_WINDOW_MS = 28 * DAY_MS
const SHADOW_WINDOW_DAYS = 14
const LOG_PAGE = 50
const PARAM_LOG = 10

export interface LearningLogView {
  id: number
  at: number
  kind: string
  symbol: string | null
  signal: SignalId | null
  /** La frase para el diario (nombres en castellano, moneda sin cotización). */
  text: string
  sampleSize: number
  before: unknown
  after: unknown
}

export interface SignalRow {
  id: SignalId
  /** "el momentum", "la tendencia mayor": para frases y tablas. */
  name: string
  /** Fiabilidad de los últimos 28 días (correlación con el retorno a 4 h). */
  reliability: ReliabilityView
  /**
   * Acierto en trades: de los trades cerrados en que la señal votó (valor ≠ 0), en
   * cuántos acertó el lado (votó a favor y ganó, o en contra y perdió). null sin votos.
   */
  hitRate: number | null
  hitTrades: number
  /** Peso global vigente y el de partida (1, o el del replay de origen). */
  weight: number
  startingWeight: number
}

export interface CoinLearningRow {
  symbol: string
  name: string
  confidence: number
  multiplier: number
  trades: number
  penaltyUntil: number | null
}

/** Dónde sigue el diario: el último cambio de la página anterior (`at` y `id`, el orden de la base). */
export interface LogCursor {
  at: number
  id: number
}

/** Una página del diario de aprendizaje, lo más nuevo primero. */
export interface LearningLogPage {
  entries: LearningLogView[]
  /** null si no hay más cambios antes. */
  nextCursor: LogCursor | null
}

export interface SessionSummary {
  session: SessionView
  /** Resultado de la cartera real: saldo − I₀ (un replay en curso, lo que lleva). */
  pnl: number
  trades: number
  won: number
}

export interface AprendizajeData {
  session: SessionView
  live: LivePayload
  /** "Juntando datos: 23 de 50" mientras `closedTrades < minTrades`. */
  progress: { closedTrades: number; minTrades: number; collecting: boolean }
  /** Congelado por Toti (ajuste) o por el estado (spec §8, controles). */
  frozen: { bySettings: boolean; byState: boolean }
  log: LearningLogPage
  /** Originales contra aprendidos en los últimos 14 días; null sin curva de sombra. */
  shadow: { comparison: ShadowComparison; curve: EquityCurve } | null
  /** Lo que trajo el pre-entrenamiento, si la sesión arrancó de un replay ("punto de partida"). */
  startingPoint: { replay: SessionView; weights: Record<SignalId, number>; params: LearningState['params'] } | null
  signals: SignalRow[]
  coins: CoinLearningRow[]
  params: {
    current: LearningState['params']
    /** Cuándo cambió por última vez (null si nunca cambió). */
    lastChangeAt: number | null
    rejected: LearningLogView[]
    tuningEnabled: boolean
  }
  /** Replays y simulaciones archivadas (sin la actual), lo más nuevo primero. */
  sessions: SessionSummary[]
  /** Replays pedidos que el bot todavía no tomó ("queda en cola"); se cancelan con `cancelCommand`. */
  queuedReplays: CommandView[]
}

export const getAprendizajeData = cache(
  async (sessionId: string, logCursor?: LogCursor): Promise<AprendizajeData | null> => {
    const [session, live] = await Promise.all([getSessionView(sessionId), getLive(sessionId)])
    if (!session || !live) return null
    const anchor = anchorOf(session, live.now)
    const settings = live.settings ?? DEFAULT_SETTINGS
    const books = await getBooks(sessionId)
    const [learning, log, reliability, paramsLog, rejected, sessions, commands, shadow, startingPoint] = await Promise.all([
      getLearning(sessionId, session.startedAt),
      getLearningLogPage(sessionId, logCursor),
      signalReliability(db, sessionId, anchor - RELIABILITY_WINDOW_MS, anchor + 1),
      learningLogOfKinds(db, sessionId, ['params'], 1),
      learningLogOfKinds(db, sessionId, ['params_rejected'], PARAM_LOG),
      getSessionSummaries(sessionId, live.now),
      session.status === 'active' ? repos.commands.listRecent(sessionId, 50) : [],
      shadowComparison(sessionId, session, books, anchor),
      originOf(session),
    ])
    const { state } = learning

    return {
      session,
      live,
      progress: {
        closedTrades: state.closedTrades,
        minTrades: settings.learning.weightLearningMinTrades,
        collecting: state.closedTrades < settings.learning.weightLearningMinTrades,
      },
      frozen: { bySettings: settings.learning.frozen, byState: state.frozen },
      log,
      shadow,
      startingPoint,
      signals: signalRows(state, books.real, reliability, startingPoint?.weights ?? null),
      coins: coinRows(state, anchor),
      params: {
        current: state.params,
        lastChangeAt: paramsLog[0]?.at ?? null,
        rejected: rejected.map(toLogView),
        tuningEnabled: settings.learning.paramTuningEnabled,
      },
      sessions,
      queuedReplays: commands
        .filter((c) => c.kind === 'run_replay' && c.status === 'pending')
        .map((c) => toCommandView(c, live.now)),
    }
  },
)

/** Una página del diario: la primera sin cursor, o la que sigue a `cursor` ("Ver anteriores"). */
export async function getLearningLogPage(sessionId: string, cursor?: LogCursor): Promise<LearningLogPage> {
  const rows = await repos.learning.listLog(sessionId, { limit: LOG_PAGE, ...(cursor ? { cursor } : {}) })
  const last = rows.at(-1)
  return {
    entries: rows.map(toLogView),
    nextCursor: last && rows.length === LOG_PAGE ? { at: last.at, id: last.id } : null,
  }
}

/**
 * Replays y simulaciones con su resultado, lo más nuevo primero, sin `excludeId` (la
 * sesión que se está mirando). También la usa el primer uso, que no tiene sesión.
 */
export const getSessionSummaries = cache(async (excludeId: string | null, now: number): Promise<SessionSummary[]> => {
  const all = await repos.sessions.listAll()
  const others = all.filter((s) => s.id !== excludeId).map((s) => toSessionView(s, now))
  const totals = await readLedgerTotalsBySession(
    db,
    others.map((s) => s.id),
  )
  return others.map((s) => {
    const t = totals.get(s.id)
    return {
      session: s,
      pnl: t ? saldoOf(s.capitalInicial, t) - s.capitalInicial : 0,
      trades: t?.closedCount ?? 0,
      won: t?.wonCount ?? 0,
    }
  })
})

function toLogView(l: LearningLogRecord): LearningLogView {
  return {
    id: l.id,
    at: l.at,
    kind: l.kind,
    symbol: l.symbol,
    signal: l.signal,
    // La frase sólo reescribe el mensaje; `kind` llega de la base como texto libre.
    text: phraseLearning(l as LearningChange),
    sampleSize: l.sampleSize,
    before: l.before,
    after: l.after,
  }
}

async function shadowComparison(
  sessionId: string,
  session: SessionView,
  books: { real: ClosedPositionRecord[]; shadow: ClosedPositionRecord[] },
  anchor: number,
): Promise<AprendizajeData['shadow']> {
  const from = anchor - SHADOW_WINDOW_DAYS * DAY_MS
  const [start, end, curve] = await Promise.all([
    equityAt(db, sessionId, from),
    equityAt(db, sessionId, anchor),
    equityCurve(db, { id: sessionId, kind: session.kind }, 'todo', session.period.from, anchor),
  ])
  // Sin punto antes de la ventana, la sesión arrancó adentro: las dos carteras valían I₀.
  const I0 = session.capitalInicial
  const startPoint = start ?? { at: session.period.from, equity: I0, shadowEquity: I0 }
  if (!end || startPoint.shadowEquity === null || end.shadowEquity === null) return null
  // `compareShadow` sólo necesita la equity en los dos bordes de la ventana.
  const track = (pick: 'equity' | 'shadowEquity', trades: ClosedPositionRecord[]) => ({
    equity: [
      { at: startPoint.at, equity: startPoint[pick] ?? 0 },
      { at: end.at, equity: end[pick] ?? 0 },
    ],
    trades,
  })
  return {
    comparison: compareShadow(track('equity', books.real), track('shadowEquity', books.shadow), session.capitalInicial, SHADOW_WINDOW_DAYS, anchor),
    curve,
  }
}

async function originOf(session: SessionView): Promise<AprendizajeData['startingPoint']> {
  if (!session.learningOrigin.startsWith('replay:')) return null
  const replayId = session.learningOrigin.slice('replay:'.length)
  const [row, state] = await Promise.all([repos.sessions.get(replayId), repos.learning.get(replayId)])
  if (!row || !state) return null
  return { replay: toSessionView(row, Date.now()), weights: state.weightsGlobal, params: state.params }
}

function signalRows(
  state: LearningState,
  real: ClosedPositionRecord[],
  reliability: Record<SignalId, ReliabilityView>,
  startingWeights: Record<SignalId, number> | null,
): SignalRow[] {
  return SIGNAL_IDS.map((id) => {
    let votes = 0
    let hits = 0
    for (const trade of real) {
      const value = trade.signalsAtOpen.find((s) => s.id === id)?.value
      if (value === null || value === undefined || value === 0) continue
      const withTrade = value * (trade.side === 'long' ? 1 : -1) > 0
      votes++
      if (withTrade === trade.pnlNet > 0) hits++
    }
    return {
      id,
      name: SIGNAL_NAMES[id],
      reliability: reliability[id],
      hitRate: votes === 0 ? null : hits / votes,
      hitTrades: votes,
      weight: state.weightsGlobal[id],
      startingWeight: startingWeights?.[id] ?? 1,
    }
  })
}

function coinRows(state: LearningState, now: number): CoinLearningRow[] {
  const symbols = new Set([...Object.keys(state.confidenceBySymbol), ...Object.keys(state.tradesBySymbol), ...Object.keys(state.penalties)])
  return [...symbols].sort().map((symbol) => ({
    symbol,
    name: coinName(symbol),
    confidence: symbolConfidence(state, symbol, now),
    multiplier: symbolMultiplier(state, symbol, now),
    trades: state.tradesBySymbol[symbol] ?? 0,
    penaltyUntil: isPenalized(state, symbol, now) ? (state.penalties[symbol] ?? null) : null,
  }))
}
