import type { ClosedPosition } from '../types'

// Estadísticas de una sesión (spec §11.1 "Estadísticas" y §9 reporte de replay).
// Todo sale de posiciones cerradas y de la serie de equity; las fracciones (winRate,
// maxDrawdownPct) van en 0–1 como el resto de los porcentajes del proyecto.
// Cada cálculo es de un solo libro: las posiciones reales o las de la sombra, nunca
// las dos juntas (mezclarlas daría números que no son de ninguna estrategia).

export interface EquityPoint {
  at: number
  equity: number
}

export interface CostBreakdown {
  fees: number
  spread: number
  slippage: number
  funding: number
}

export interface SymbolStats {
  trades: number
  wins: number
  pnlNet: number
  winRate: number
}

export interface Stats {
  trades: number
  wins: number
  losses: number
  winRate: number
  /** Ganancias brutas / pérdidas brutas en pnlNet; `Infinity` si no hubo pérdidas. */
  profitFactor: number
  /** Media de `rMultiple`. */
  expectancyR: number
  avgWin: number
  /** Media de pnlNet de los perdidos (negativa). */
  avgLoss: number
  bestTrade: number
  worstTrade: number
  maxDrawdownPct: number
  costs: CostBreakdown
  /** Costo total / riesgo total: cuánto de cada R se va en costos. */
  costPerRiskR: number
  liquidations: number
  bySymbol: Record<string, SymbolStats>
}

export interface Drawdown {
  pct: number
  peakAt: number | null
  troughAt: number | null
}

const sum = (values: number[]): number => values.reduce((acc, v) => acc + v, 0)
const mean = (values: number[]): number => (values.length === 0 ? 0 : sum(values) / values.length)

const isWin = (c: ClosedPosition): boolean => c.pnlNet > 0
const isLoss = (c: ClosedPosition): boolean => c.pnlNet < 0

/** Lanza si `closed` mezcla posiciones reales y de la sombra. */
export function assertSingleBook(closed: readonly ClosedPosition[]): void {
  const first = closed[0]
  if (first === undefined) return
  if (closed.some((c) => c.shadow !== first.shadow)) {
    throw new RangeError('las posiciones mezclan reales y de la sombra: calculá cada libro por separado')
  }
}

export function expectancyR(closed: ClosedPosition[]): number {
  return mean(closed.map((c) => c.rMultiple))
}

export function profitFactor(closed: ClosedPosition[]): number {
  const grossWins = sum(closed.filter(isWin).map((c) => c.pnlNet))
  const grossLosses = -sum(closed.filter(isLoss).map((c) => c.pnlNet))
  if (grossLosses === 0) return grossWins > 0 ? Number.POSITIVE_INFINITY : 0
  return grossWins / grossLosses
}

// Peor caída desde un pico previo, en fracción del pico. La serie va en orden
// cronológico; un pico en 0 o negativo no define caída.
export function maxDrawdown(series: EquityPoint[]): Drawdown {
  let peak: EquityPoint | null = null
  let worst: Drawdown = { pct: 0, peakAt: null, troughAt: null }
  for (const point of series) {
    if (peak === null || point.equity > peak.equity) {
      peak = point
      continue
    }
    if (peak.equity <= 0) continue
    const pct = (peak.equity - point.equity) / peak.equity
    if (pct > worst.pct) worst = { pct, peakAt: peak.at, troughAt: point.at }
  }
  return worst
}

function sumCosts(closed: ClosedPosition[]): CostBreakdown {
  return {
    fees: sum(closed.map((c) => c.costs.fees)),
    spread: sum(closed.map((c) => c.costs.spread)),
    slippage: sum(closed.map((c) => c.costs.slippage)),
    funding: sum(closed.map((c) => c.costs.funding)),
  }
}

function groupBySymbol(closed: ClosedPosition[]): Record<string, SymbolStats> {
  const bySymbol: Record<string, SymbolStats> = {}
  for (const c of closed) {
    const current = bySymbol[c.symbol] ?? { trades: 0, wins: 0, pnlNet: 0, winRate: 0 }
    const trades = current.trades + 1
    const wins = current.wins + (isWin(c) ? 1 : 0)
    bySymbol[c.symbol] = { trades, wins, pnlNet: current.pnlNet + c.pnlNet, winRate: wins / trades }
  }
  return bySymbol
}

export function computeStats(closed: ClosedPosition[], equity: EquityPoint[]): Stats {
  assertSingleBook(closed)
  const winsPnl = closed.filter(isWin).map((c) => c.pnlNet)
  const lossesPnl = closed.filter(isLoss).map((c) => c.pnlNet)
  const pnls = closed.map((c) => c.pnlNet)
  const costs = sumCosts(closed)
  const totalCost = costs.fees + costs.spread + costs.slippage + costs.funding
  const totalRisk = sum(closed.map((c) => c.riesgoReal))

  return {
    trades: closed.length,
    wins: winsPnl.length,
    losses: lossesPnl.length,
    winRate: closed.length === 0 ? 0 : winsPnl.length / closed.length,
    profitFactor: profitFactor(closed),
    expectancyR: expectancyR(closed),
    avgWin: mean(winsPnl),
    avgLoss: mean(lossesPnl),
    bestTrade: pnls.reduce((best, v) => Math.max(best, v), pnls.length === 0 ? 0 : -Infinity),
    worstTrade: pnls.reduce((worst, v) => Math.min(worst, v), pnls.length === 0 ? 0 : Infinity),
    maxDrawdownPct: maxDrawdown(equity).pct,
    costs,
    costPerRiskR: totalRisk === 0 ? 0 : totalCost / totalRisk,
    liquidations: closed.filter((c) => c.closeReason === 'liquidation').length,
    bySymbol: groupBySymbol(closed),
  }
}
