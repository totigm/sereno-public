import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { SIGNAL_IDS, type SignalId } from '@sereno/core'
import type { ReplayBookStats, ReplayReport } from '@sereno/db'
import type { ResumenScreenProps } from '@/components/resumen/resumen-screen'
import { ToastProvider } from '@/components/ui/toast'
import type { LiveState } from '@/lib/live/provider'
import type { LedgerView, LivePayload } from '@/lib/live/types'
import type { EquityCurve, EquityRange } from '@/lib/queries/equity-curve'
import type { JournalEntry, JournalView } from '@/lib/queries/journal'
import type { FirstRunData } from '@/lib/queries/resumen'
import type { EquityPointView } from '@/lib/queries/sql/equity'
import { statsView, verdictView } from '@/lib/queries/stats'
import { BOT, livePayload, liveSession, NOW } from '../nav/fixtures'

// Datos de Resumen para los tests: la simulación del ejemplo de la spec (arrancó el 14 de
// octubre con US$ 1.000, 23 cerradas, 14 ganadas, saldo US$ 1.247,80).

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** 14:32 en Buenos Aires del día de `NOW`. */
export const AT_1432 = Date.UTC(2026, 9, 31, 17, 32)

const DRAWDOWN = { pct: 0.04, peakAt: null, troughAt: null, resolution: 'minute' as const }

export function ledger(patch: Partial<LedgerView> = {}): LedgerView {
  return { ...livePayload().ledger, saldo: 1247.8, closedCount: 23, wonCount: 14, equityAtDayStart: 1209.6, ...patch }
}

/** La simulación activa en vivo, con el bot conectado y sin abiertas. */
export function activeLive(patch: Partial<LivePayload> = {}): LivePayload {
  return livePayload({ ledger: ledger(), ...patch })
}

/** El bot dejó de latir a las 14:32 (la hora del último snapshot). */
export function offlineLive(patch: Partial<LivePayload> = {}): LivePayload {
  return activeLive({
    offline: true,
    botStatus: { ...BOT, lastHeartbeat: AT_1432 },
    market: { version: 9, updatedAt: AT_1432, symbols: [] },
    ...patch,
  })
}

export function point(at: number, equity: number, patch: Partial<EquityPointView> = {}): EquityPointView {
  return { at, equity, saldo: equity, shadowEquity: null, gapBefore: false, ...patch }
}

function curve(from: number, points: EquityPointView[]): EquityCurve {
  return { from, to: NOW, bucketMs: 0, points }
}

/** Una curva que sube de 1.000 a 1.247,80 en los últimos días. */
export function curves(): Record<EquityRange, EquityCurve> {
  const points = Array.from({ length: 8 }, (_, i) => point(NOW - (7 - i) * DAY, 1000 + (247.8 * i) / 7))
  return {
    hoy: curve(NOW - 15 * HOUR, points.slice(-1)),
    '7d': curve(NOW - 7 * DAY, points),
    '30d': curve(NOW - 17 * DAY, points),
    todo: curve(NOW - 17 * DAY, points),
  }
}

export function journalEntry(id: string, patch: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id,
    at: AT_1432,
    kind: 'open',
    text: 'Abrí un long 5x en SOL con US$ 50. La tendencia en 1h y 4h acompaña.',
    symbol: 'SOLUSDT',
    positionId: null,
    pnl: null,
    highlight: false,
    reported: false,
    ...patch,
  }
}

export function journal(entries: JournalEntry[] = [], summary: Partial<JournalView['summary']> = {}): JournalView {
  return {
    from: Date.UTC(2026, 9, 30, 3, 0),
    to: NOW,
    summary: { trades: 4, won: 3, pnl: 22.1, cycles: 32, coins: 30, liquidations: 0, ...summary },
    entries,
  }
}

/** Lo que el servidor le pasa a la pantalla (sin la parte en vivo). */
export function screenData(patch: Partial<ResumenScreenProps['data']> = {}): ResumenScreenProps['data'] {
  const session = patch.session ?? liveSession()
  return {
    session,
    equity: { ranges: curves(), defaultRange: session.status === 'active' ? '7d' : 'todo' },
    verdict: verdictView({ real: [], shadowTrades: 0, days: 17, drawdown: DRAWDOWN, capitalInicial: 1000, equity: 1247.8, shadowEquity: null, seed: 'test' }),
    stats: statsView([], DRAWDOWN),
    journal: journal(),
    shieldedAt: null,
    trade: null,
    report: null,
    ...patch,
  }
}

export const FIRST_RUN: FirstRunData = {
  learningSources: { continued: false, replays: [] },
  defaults: { capital: 1000, protectPct: 0.7, mode: 'auto' },
}

/**
 * Lo que devuelve `useLiveContext` (los tests lo reemplazan con `vi.mock`): así cada
 * test fija qué llega en la consulta en vivo.
 */
export function liveState(data: LivePayload): LiveState {
  return { data, error: null, updatedAt: data.now, isFetching: false, refetch: vi.fn() as unknown as LiveState['refetch'] }
}

/** Los avisos, como los pone el shell. */
export function withToasts(ui: ReactNode): ReactNode {
  return <ToastProvider>{ui}</ToastProvider>
}

const UTC_DAY = (month: number, day: number) => Date.UTC(2026, month - 1, day)
const CANDLE = 15 * 60_000

/** Un tramo sin una señal en una moneda, de un día (UTC) a otro, con decisiones cada 15 minutos. */
function missing(signal: SignalId, symbol: string, from: number, to: number): ReplayReport['missingSignalWindows'][number] {
  return { signal, symbol, from, to, decisions: Math.round((to - from) / CANDLE) + 1 }
}

/** Correlación con todos los pares en 0,1 salvo los que se fijan (en el orden de `SIGNAL_IDS`). */
function correlation(fixed: [SignalId, SignalId, number | null][]): ReplayReport['correlation'] {
  const ids = [...SIGNAL_IDS]
  const valueOf = (a: SignalId, b: SignalId) => {
    const pair = fixed.find(([x, y]) => (x === a && y === b) || (x === b && y === a))
    return pair === undefined ? 0.1 : pair[2]
  }
  const rho = ids.map((a, i) => ids.map((b, j) => (i === j ? 1 : valueOf(a, b))))
  const pairs = ids.map((a, i) => ids.map((b, j) => (rho[i]?.[j] === null ? 0 : 12_400)))
  return { signals: ids, rho, pairs }
}

/**
 * El reporte de un replay de 90 días (2 ago → 31 oct, UTC) como lo deja el bot (spec §9):
 * dos quincenas con trades, interés abierto y posicionamiento sólo desde el 1 oct, el
 * funding de SOL faltando dos veces y PEPE entrando por SOL el 4 ago.
 */
export function replayReport(patch: Partial<ReplayReport> = {}): ReplayReport {
  const book: ReplayBookStats = {
    trades: 21,
    wins: 10,
    losses: 11,
    winRate: 10 / 21,
    profitFactor: 1.2,
    expectancyR: 0.05,
    avgWin: 12,
    avgLoss: -9,
    bestTrade: 30,
    worstTrade: -20,
    maxDrawdownPct: 0.08,
    costs: { fees: 4, spread: 1, slippage: 0.5, funding: 0.2 },
    costPerRiskR: 0.12,
    liquidations: 0,
    netPnl: 26.6,
    roi: 0.0266,
    finalEquity: 1026.6,
    openAtEnd: 0,
    bestSymbol: null,
    worstSymbol: null,
    bySymbol: {},
    byFortnight: [
      { from: UTC_DAY(8, 2), to: UTC_DAY(8, 17), trades: 12, wins: 7, pnlNet: 45.2 },
      { from: UTC_DAY(8, 17), to: UTC_DAY(9, 1), trades: 9, wins: 3, pnlNet: -18.6 },
    ],
  }
  const coins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
  return {
    version: 1,
    from: UTC_DAY(8, 2),
    to: UTC_DAY(10, 31),
    days: 90,
    capital: 1000,
    paramTuning: false,
    learning: { origin: 'zero', fromSessionId: null },
    stats: { real: book, shadow: book },
    shadowComparison: { from: 0, to: 0, learnedPp: 0, shadowPp: 0, gapPp: 0, sumRLearned: 0, sumRShadow: 0, tradesLearned: 0, tradesShadow: 0, enoughTrades: false, warn: false },
    // Barras de 0,05 entre −1 y +1 en triángulo: 0 en las puntas, 19 en las dos del medio (380 en total).
    signalHistogram: Array.from({ length: 40 }, (_, i) => ({ from: (i - 20) / 20, to: (i - 19) / 20, count: i < 20 ? i : 39 - i })),
    correlation: correlation([
      ['trend15m', 'trendHigher', 0.82],
      ['momentum', 'breakout', -0.4],
      ['funding', 'positioning', null],
    ]),
    universeByDay: {
      '2026-08-02': coins,
      '2026-08-03': coins,
      '2026-08-04': ['BTCUSDT', 'ETHUSDT', 'PEPEUSDT'],
    },
    missingSignalWindows: [
      ...coins.map((s) => missing('openInterest', s, UTC_DAY(8, 2), UTC_DAY(9, 30) + 95 * CANDLE)),
      ...coins.map((s) => missing('positioning', s, UTC_DAY(8, 2), UTC_DAY(9, 30) + 95 * CANDLE)),
      missing('funding', 'SOLUSDT', UTC_DAY(8, 20) + 80 * CANDLE, UTC_DAY(8, 21) + 4 * CANDLE),
      missing('funding', 'SOLUSDT', UTC_DAY(9, 5) + 10 * CANDLE, UTC_DAY(9, 5) + 12 * CANDLE),
    ],
    missingMarkWindows: [{ symbol: 'PEPEUSDT', from: UTC_DAY(8, 4), to: UTC_DAY(8, 4) + 3 * CANDLE, decisions: 4 }],
    caveats: { drawdownPause: null, shadowOppositeSideCandles: 0, futuresDataFrom: UTC_DAY(10, 1), survivorshipBias: true },
    failures: { total: 0, first: [] },
    data: { symbols: [...coins, 'PEPEUSDT'], skipped: [], candlesReused: 1000, candlesDownloaded: 200 },
    ...patch,
  }
}
