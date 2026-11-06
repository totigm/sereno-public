// El reporte de un replay terminado (spec §9) a partir del resultado del core: todo en JSON
// (sin `Infinity`), con ROI, la mejor y la peor moneda, los tramos de 15 días y las
// advertencias de lo que el replay no pudo reproducir.

import type { ClosedPosition, Position } from '@sereno/core'
import { DAY_MS } from '@sereno/core/src/replay/clock'
import type { ReplayResult } from '@sereno/core/src/replay/types'
import type { Stats, SymbolStats } from '@sereno/core/src/stats/stats'
import type { ReplayBookStats, ReplayFortnight, ReplayReport, ReplaySymbolResult } from '@sereno/db'
import type { DownloadMeta } from './download'
import type { Period } from './period'

const FORTNIGHT_MS = 15 * DAY_MS
// Las fallas van contadas; con detalle, sólo las primeras.
const FAILURES_WITH_DETAIL = 20

export interface ReportInput {
  result: ReplayResult
  period: Period
  capital: number
  paramTuning: boolean
  learning: ReplayReport['learning']
  meta: DownloadMeta
}

export function buildReport({ result, period, capital, paramTuning, learning, meta }: ReportInput): ReplayReport {
  const last = result.equity.at(-1)
  const book = (key: 'real' | 'shadow'): ReplayBookStats =>
    bookStats(result.stats[key], result.closed[key], result.open[key], last?.[key].equity ?? capital, capital, period)
  return {
    version: 1,
    from: period.from,
    to: period.to,
    days: Math.round((period.to - period.from) / DAY_MS),
    capital,
    paramTuning,
    learning,
    stats: { real: book('real'), shadow: book('shadow') },
    shadowComparison: result.shadowComparison,
    signalHistogram: result.signalHistogram,
    correlation: result.correlation,
    universeByDay: result.universeByDay,
    missingSignalWindows: result.missingSignalWindows,
    missingMarkWindows: result.missingMarkWindows,
    caveats: { ...result.caveats, futuresDataFrom: meta.futuresDataFrom, survivorshipBias: true },
    failures: { total: result.failures.length, first: result.failures.slice(0, FAILURES_WITH_DETAIL) },
    data: { symbols: meta.symbols, skipped: meta.skipped, candlesReused: meta.candlesReused, candlesDownloaded: meta.candlesDownloaded },
  }
}

function bookStats(stats: Stats, closed: readonly ClosedPosition[], open: readonly Position[], finalEquity: number, capital: number, period: Period): ReplayBookStats {
  const netPnl = closed.reduce((acc, p) => acc + p.pnlNet, 0)
  const { best, worst } = symbolExtremes(stats.bySymbol)
  return {
    ...stats,
    profitFactor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null,
    netPnl,
    roi: netPnl / capital,
    finalEquity,
    openAtEnd: open.length,
    bestSymbol: best,
    worstSymbol: worst,
    byFortnight: fortnights(closed, period),
  }
}

// La mejor y la peor moneda por resultado neto. Con menos de dos monedas operadas no hay
// con qué comparar: la única no es "la mejor" ni "la peor".
export function symbolExtremes(bySymbol: Readonly<Record<string, SymbolStats>>): { best: ReplaySymbolResult | null; worst: ReplaySymbolResult | null } {
  const symbols = Object.entries(bySymbol)
    .map(([symbol, s]): ReplaySymbolResult => ({ symbol, trades: s.trades, pnlNet: s.pnlNet }))
    .sort((a, b) => b.pnlNet - a.pnlNet || (a.symbol < b.symbol ? -1 : 1))
  if (symbols.length < 2) return { best: null, worst: null }
  return { best: symbols[0] ?? null, worst: symbols.at(-1) ?? null }
}

// Trades cerrados por tramo de 15 días desde el inicio (el último puede ser más corto).
function fortnights(closed: readonly ClosedPosition[], { from, to }: Period): ReplayFortnight[] {
  const out: ReplayFortnight[] = []
  for (let start = from; start < to; start += FORTNIGHT_MS) {
    const end = Math.min(to, start + FORTNIGHT_MS)
    const inside = closed.filter((p) => p.closedAt >= start && p.closedAt < end)
    out.push({ from: start, to: end, trades: inside.length, wins: inside.filter((p) => p.pnlNet > 0).length, pnlNet: inside.reduce((acc, p) => acc + p.pnlNet, 0) })
  }
  return out
}
