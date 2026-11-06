import type { ClosedPosition, Position } from '@sereno/core'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { PosicionesScreenProps } from '@/components/posiciones/posiciones-screen'
import { tradeScope, type TradeScope } from '@/components/posiciones/trade-model'
import { ToastProvider } from '@/components/ui/toast'
import { startOfDayBA } from '@/lib/format'
import type { LiveState } from '@/lib/live/provider'
import type { CommandView, LivePayload, OpenPositionView, PositionValuation } from '@/lib/live/types'
import type { ClosedTradeView } from '@/lib/queries/posiciones'
import { statsView, verdictView } from '@/lib/queries/stats'
import { closedPosition, position } from '../fixtures'
import { contextFor, livePayload, liveSession, NOW, replaySession } from '../nav/fixtures'

// Datos de Posiciones para los tests: la abierta del spec ("SOL · Long 5x · +US$ 12,40
// (+4,1%)", "entró a 142,10 · ahora 148,30 · 3 h") y cerradas de la sesión activa.

export const HOUR = 3_600_000

const extras = { sessionId: 'ses_live', missingSignals: [], latencyMs: null }

export function openView(id: string, patch: Partial<Position> = {}, valuation: Partial<PositionValuation> = {}): OpenPositionView {
  return {
    ...position(id, patch),
    ...extras,
    valuation: { mark: 125, unrealized: 0, net: 0, r: 0, pctOfMargin: 0, ...valuation },
  }
}

/** SOL long 5x: entró a 142,10 hace 3 h, la marca está en 148,30 y cerrarla deja +US$ 12,40 (+4,1% del margen). */
export function solOpen(): OpenPositionView {
  return openView(
    'pos-sol',
    { entryPrice: 142.1, openedAt: NOW - 3 * HOUR, stopPrice: 139.3, takeProfitPrice: 150, liquidationPrice: 115.2, margin: 302.44 },
    { mark: 148.3, unrealized: 12.6, net: 12.4, r: 2.48, pctOfMargin: 12.4 / 302.44 },
  )
}

export function closedView(id: string, patch: Partial<ClosedPosition> = {}): ClosedTradeView {
  const closed = closedPosition(id, patch)
  return { ...closed, ...extras, closePhrase: null, day: startOfDayBA(closed.closedAt) }
}

export function command(patch: Partial<CommandView> = {}): CommandView {
  return {
    id: 'cmd-1',
    kind: 'close_position',
    payload: { symbol: 'SOLUSDT' },
    status: 'pending',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 59_000,
    claimedAt: null,
    finishedAt: null,
    result: null,
    requestedBy: 'owner@example.com',
    expired: false,
    ...patch,
  }
}

export function activeScope(live: LivePayload = livePayload()): TradeScope {
  return tradeScope(contextFor(liveSession()), live)
}

export function replayScope(live: LivePayload = livePayload({ sessionId: 'ses_replay' })): TradeScope {
  return tradeScope(contextFor(replaySession()), live)
}

/**
 * Lo que devuelve `useLiveContext` (los tests lo reemplazan con `vi.mock`): así cada
 * test fija qué llega en la consulta en vivo y lo cambia entre renders.
 */
export function liveState(data: LivePayload): LiveState {
  return { data, error: null, updatedAt: data.now, isFetching: false, refetch: vi.fn() as unknown as LiveState['refetch'] }
}

/** Los avisos, como los pone el shell. */
export function withToasts(ui: ReactNode): ReactNode {
  return <ToastProvider>{ui}</ToastProvider>
}

const DRAWDOWN = { pct: 0.023, peakAt: null, troughAt: null, resolution: 'event' as const }

/** Lo que el servidor le pasa a la pantalla (sin la parte en vivo), con estadísticas y veredicto de verdad. */
export function screenData(closed: ClosedTradeView[] = [], patch: Partial<PosicionesScreenProps['data']> = {}): PosicionesScreenProps['data'] {
  return {
    session: liveSession(),
    closed: { items: closed, hasMore: false, page: 1, pageSize: 50, query: {}, symbols: [...new Set(closed.map((c) => c.symbol))].sort() },
    stats: statsView(closed, DRAWDOWN),
    verdict: verdictView({ real: closed, shadowTrades: 0, days: 16, drawdown: DRAWDOWN, capitalInicial: 1000, equity: 1000, shadowEquity: null, seed: 'test' }),
    trade: null,
    ...patch,
  }
}
