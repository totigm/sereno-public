import { SIGNAL_IDS, type SignalId } from '@sereno/core'
import type { ShadowComparison } from '@sereno/core/src/learning/shadow'
import { SIGNAL_NAMES } from '@sereno/core/src/journal/phrases'
import type { SessionRow } from '@sereno/db'
import type { ReactNode } from 'react'
import { ToastProvider } from '@/components/ui/toast'
import { LiveProvider } from '@/lib/live/provider'
import type { CommandView, LivePayload } from '@/lib/live/types'
import type { AprendizajeData, LearningLogView, SessionSummary, SignalRow } from '@/lib/queries/aprendizaje'
import { toSessionView, type SessionView } from '@/lib/queries/session'
import { livePayload, liveSession, NOW, withQueryClient } from '../nav/fixtures'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export { NOW }

export function logEntry(id: number, patch: Partial<LearningLogView> = {}): LearningLogView {
  return {
    id,
    at: NOW - id * HOUR,
    kind: 'confidence',
    symbol: 'SOLUSDT',
    signal: null,
    text: `Confianza en SOL: 0,10 → 0,20 tras +1,00R (n = ${id}).`,
    sampleSize: id,
    before: 0.1,
    after: 0.2,
    ...patch,
  }
}

export function comparison(patch: Partial<ShadowComparison> = {}): ShadowComparison {
  return {
    from: NOW - 14 * DAY,
    to: NOW,
    learnedPp: 2.1,
    shadowPp: 5.3,
    gapPp: 3.2,
    sumRLearned: 4.5,
    sumRShadow: 9.8,
    tradesLearned: 24,
    tradesShadow: 22,
    enoughTrades: true,
    warn: true,
    ...patch,
  }
}

function signalRows(): SignalRow[] {
  return SIGNAL_IDS.map((id: SignalId, i) => ({
    id,
    name: SIGNAL_NAMES[id],
    reliability: i === 0 ? { rho: 0.12, n: 812 } : { rho: null, n: 4 },
    hitRate: i === 0 ? 0.58 : null,
    hitTrades: i === 0 ? 19 : 0,
    weight: i === 0 ? 1.12 : 1,
    startingWeight: 1,
  }))
}

/** Una sesión replay con su resultado, para la lista de replays y simulaciones. */
export function summary(session: SessionView, patch: Partial<Omit<SessionSummary, 'session'>> = {}): SessionSummary {
  return { session, pnl: 0, trades: 0, won: 0, ...patch }
}

export function replayRow(patch: Partial<SessionRow>): SessionView {
  return toSessionView(
    {
      id: 'rep_x',
      kind: 'replay',
      name: 'Replay de 90 días',
      status: 'listo',
      capitalInicial: 1000,
      baseBlindaje: 1000,
      protegido: 0,
      settingsSnapshot: livePayload().settings!,
      learningOrigin: 'zero',
      startedAt: new Date(NOW - 2 * HOUR),
      endedAt: null,
      progreso: 1,
      mensaje: null,
      replayParams: { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: false },
      binanceEnv: null,
      realStatus: null,
      realOffReason: null,
      realChangedAt: null,
      ...patch,
    },
    NOW,
  )
}

export const RUNNING_REPLAY = replayRow({
  id: 'rep_corriendo',
  name: 'Replay 90 días con lo aprendido',
  status: 'simulando',
  progreso: 41 / 90,
  mensaje: 'Simulando · día 41 de 90',
  replayParams: { days: 90, capital: 1000, learningOrigin: 'current', paramTuning: false },
})

export const FINISHED_REPLAY = replayRow({
  id: 'rep_listo',
  name: 'Replay 90 días',
  status: 'listo',
  endedAt: new Date(NOW - HOUR),
  mensaje: 'Con 128 operaciones en 90 días: ventaja positiva (expectativa +0,48R, 95% de confianza).',
})

export function queuedCommand(patch: Partial<CommandView> = {}): CommandView {
  return {
    id: '7c1d8a52-8f0e-4a43-9d38-0d1c0b6f2b11',
    kind: 'run_replay',
    payload: { days: 30, capital: 2000, learningOrigin: 'zero', paramTuning: false },
    status: 'pending',
    createdAt: NOW - 60_000,
    expiresAt: null,
    claimedAt: null,
    finishedAt: null,
    result: null,
    requestedBy: 'owner@example.com',
    expired: false,
    ...patch,
  }
}

export function aprendizajeData(patch: Partial<AprendizajeData> = {}): AprendizajeData {
  const live = patch.live ?? livePayload()
  return {
    session: liveSession(),
    live,
    progress: { closedTrades: 23, minTrades: 50, collecting: true },
    frozen: { bySettings: false, byState: false },
    log: { entries: [logEntry(1), logEntry(2), logEntry(3, { kind: 'penalty', text: 'WIF queda en penitencia 7 días: confianza −0,45 tras 8 trades.' })], nextCursor: null },
    shadow: {
      comparison: comparison({ warn: false, gapPp: -0.4, learnedPp: 5.8, shadowPp: 5.4 }),
      curve: {
        from: NOW - 17 * DAY,
        to: NOW,
        bucketMs: HOUR,
        points: [0, 1, 2, 3].map((i) => ({
          at: NOW - (17 - i * 5) * DAY,
          equity: 1000 + i * 20,
          saldo: 1000 + i * 20,
          shadowEquity: 1000 + i * 18,
          gapBefore: false,
        })),
      },
    },
    startingPoint: null,
    signals: signalRows(),
    coins: [
      { symbol: 'WIFUSDT', name: 'WIF', confidence: -0.45, multiplier: 0.55, trades: 8, penaltyUntil: NOW + 3 * DAY },
      { symbol: 'SOLUSDT', name: 'SOL', confidence: 0.34, multiplier: 1, trades: 2, penaltyUntil: null },
    ],
    params: {
      current: { theta: 0.35, k: 1.5, tpR: 2, trailingR: 1, since: NOW - 17 * DAY },
      lastChangeAt: null,
      rejected: [],
      tuningEnabled: true,
    },
    sessions: [summary(RUNNING_REPLAY), summary(FINISHED_REPLAY, { pnl: 576.41, trades: 128, won: 80 })],
    queuedReplays: [],
    ...patch,
  }
}

/** Los toasts que pone `Providers` en la app. */
export function withToasts(ui: ReactNode): ReactNode {
  return <ToastProvider>{ui}</ToastProvider>
}

/** Lo que pone la app alrededor de una pantalla: consulta en vivo (quieta en los tests) y toasts. */
export function withScreen(ui: ReactNode, live: LivePayload = livePayload()): ReactNode {
  return withQueryClient(
    <LiveProvider sessionId={live.sessionId} initial={live} enabled={false}>
      <ToastProvider>{ui}</ToastProvider>
    </LiveProvider>,
  )
}
