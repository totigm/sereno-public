import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { ReactNode } from 'react'
import type { BotStatusView, LivePayload } from '@/lib/live/types'
import { contextOf, toSessionView, type SessionContext, type SessionView } from '@/lib/queries/session'

const DAY_MS = 86_400_000

/** 31 de octubre de 2026, 15:32 en Buenos Aires. */
export const NOW = Date.UTC(2026, 9, 31, 18, 32)

function row(patch: Partial<SessionRow>): SessionRow {
  return {
    id: 'ses_live',
    kind: 'paper_live',
    name: 'Simulación',
    status: 'active',
    capitalInicial: 1000,
    baseBlindaje: 1000,
    protegido: 0,
    settingsSnapshot: DEFAULT_SETTINGS,
    learningOrigin: 'zero',
    startedAt: new Date(Date.UTC(2026, 9, 14, 13, 15)),
    endedAt: null,
    progreso: null,
    mensaje: null,
    replayParams: null,
    binanceEnv: null,
    realStatus: null,
    realOffReason: null,
    realChangedAt: null,
    ...patch,
  }
}

export function liveSession(): SessionView {
  return toSessionView(row({}), NOW)
}

/** La sesión con plata real activa, en testnet, junto a la simulación en papel. */
export function realSession(patch: Partial<SessionRow> = {}): SessionView {
  return toSessionView(realRow(patch), NOW)
}

export function realRow(patch: Partial<SessionRow> = {}): SessionRow {
  return row({
    id: 'ses_real',
    kind: 'live',
    name: 'Plata real',
    capitalInicial: 50,
    baseBlindaje: 50,
    startedAt: new Date(Date.UTC(2026, 9, 30, 13, 0)),
    binanceEnv: 'testnet',
    realStatus: 'on',
    realChangedAt: new Date(Date.UTC(2026, 9, 30, 13, 0)),
    ...patch,
  })
}

/** Replay de 90 días pedido el 31 de octubre: cubre del 2 de agosto al 31 de octubre. */
export function replaySession(patch: Partial<SessionRow> = {}): SessionView {
  return toSessionView(
    row({
      id: 'ses_replay',
      kind: 'replay',
      name: 'Replay · 90 días',
      status: 'listo',
      startedAt: new Date(Date.UTC(2026, 9, 31, 15, 0)),
      endedAt: new Date(Date.UTC(2026, 9, 31, 15, 4)),
      progreso: 1,
      replayParams: { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: false },
      ...patch,
    }),
    NOW,
  )
}

/** Simulación en vivo archivada: del 14 al 20 de octubre. */
export function archivedSession(): SessionView {
  return toSessionView(
    row({
      id: 'ses_old',
      status: 'archived',
      startedAt: new Date(Date.UTC(2026, 9, 14, 13, 15)),
      endedAt: new Date(Date.UTC(2026, 9, 20, 21, 0)),
    }),
    NOW,
  )
}

export function contextFor(session: SessionView | null): SessionContext {
  return contextOf(session)
}

export const BOT: BotStatusView = {
  instanceId: 'mac-1',
  lastHeartbeat: NOW - 5_000,
  phase: 'live',
  warmProgress: 30,
  universeSize: 30,
  // 14:32 en Buenos Aires.
  lastCycleAt: Date.UTC(2026, 9, 31, 17, 32),
  settingsVersionApplied: 3,
  degradedSymbols: [],
  flags: { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false },
  recentErrors: [],
  botVersion: '0.1.0',
  real: null,
}

export function livePayload(patch: Partial<LivePayload> = {}): LivePayload {
  return {
    version: 'v1',
    sessionId: 'ses_live',
    now: NOW,
    offline: false,
    market: null,
    open: [],
    botStatus: BOT,
    equityLast: null,
    settingsVersion: 3,
    settings: DEFAULT_SETTINGS,
    ledger: {
      capitalInicial: 1000,
      startedAt: NOW - 17 * DAY_MS,
      saldo: 1000,
      protegido: 0,
      baseBlindaje: 1000,
      closedCount: 0,
      wonCount: 0,
      dayStart: Date.UTC(2026, 9, 31, 3, 0),
      equityAtDayStart: 1000,
    },
    commands: [],
    realStatus: null,
    ...patch,
  }
}

/** El cliente de TanStack Query que en la app pone `Providers`; sin reintentos para que un error se vea enseguida. */
export function withQueryClient(ui: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}
