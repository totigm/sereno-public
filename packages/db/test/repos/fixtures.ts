import type { ClosedPosition, Position, SignalResult } from '@sereno/core'
import type { ReplayBookStats, ReplayReport } from '../../src/schema'

export const SIGNALS: SignalResult[] = [
  { id: 'trend15m', value: 0.6 },
  { id: 'momentum', value: 0.4, detail: { rsi: 61 } },
  { id: 'funding', value: null },
]

export function position(id: string, patch: Partial<Position> = {}): Position {
  return {
    id,
    symbol: 'SOLUSDT',
    side: 'long',
    leverage: 5,
    margin: 50,
    notional: 250,
    qty: 2,
    entryPrice: 125,
    openedAt: Date.parse('2026-10-31T10:00:00Z'),
    stopPrice: 122.5,
    takeProfitPrice: 130,
    liquidationPrice: 101.2,
    distanciaStop: 2.5,
    riesgoReal: 5,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 125,
    stopOrderId: 'stop-1',
    tpOrderId: 'tp-1',
    feesPaid: 0.125,
    fundingPaid: 0,
    shadow: false,
    openReason: 'Entré long en SOL: tendencia y momento a favor.',
    signalsAtOpen: SIGNALS,
    mode: 'auto',
    ...patch,
  }
}

export function closed(id: string, patch: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    ...position(id),
    closedAt: Date.parse('2026-10-31T14:00:00Z'),
    exitPrice: 130,
    closeReason: 'take_profit',
    pnlGross: 10,
    pnlNet: 9.745,
    rMultiple: 1.949,
    costs: { fees: 0.255, spread: 0.05, slippage: 0.03, funding: 0 },
    ...patch,
  }
}

// El reporte de un replay de 3 días sin trades.
export function replayReport(capital: number): ReplayReport {
  const book: ReplayBookStats = {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    profitFactor: null,
    expectancyR: 0,
    avgWin: 0,
    avgLoss: 0,
    bestTrade: 0,
    worstTrade: 0,
    maxDrawdownPct: 0,
    costs: { fees: 0, spread: 0, slippage: 0, funding: 0 },
    costPerRiskR: 0,
    liquidations: 0,
    netPnl: 0,
    roi: 0,
    finalEquity: capital,
    openAtEnd: 0,
    bestSymbol: null,
    worstSymbol: null,
    bySymbol: {},
    byFortnight: [],
  }
  return {
    version: 1,
    from: Date.UTC(2026, 9, 1),
    to: Date.UTC(2026, 9, 4),
    days: 3,
    capital,
    paramTuning: false,
    learning: { origin: 'zero', fromSessionId: null },
    stats: { real: book, shadow: book },
    shadowComparison: { from: 0, to: 0, learnedPp: 0, shadowPp: 0, gapPp: 0, sumRLearned: 0, sumRShadow: 0, tradesLearned: 0, tradesShadow: 0, enoughTrades: false, warn: false },
    signalHistogram: [],
    correlation: { signals: [], rho: [], pairs: [] },
    universeByDay: { '2026-10-01': ['BTCUSDT'] },
    missingSignalWindows: [],
    missingMarkWindows: [],
    caveats: { drawdownPause: null, shadowOppositeSideCandles: 0, futuresDataFrom: null, survivorshipBias: true },
    failures: { total: 0, first: [] },
    data: { symbols: ['BTCUSDT'], skipped: [{ symbol: 'ETHUSDT', error: 'Invalid symbol.' }], candlesReused: 10, candlesDownloaded: 5 },
  }
}
