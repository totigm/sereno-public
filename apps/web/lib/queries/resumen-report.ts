import { SIGNAL_IDS, type SignalId } from '@sereno/core'
import type { DrawdownPause, HistogramBin, MissingSignalWindow } from '@sereno/core/src/replay/types'
import type { ReplayFortnight, ReplayReport } from '@sereno/db'

// El reporte de un replay terminado (spec §9) para Resumen: lo que el bot dejó en
// `sessions.report`, reducido a lo que se muestra. Va al cliente sin las fallas con
// detalle, los libros de la sombra ni las monedas de cada día repetidas.

const DAY_MS = 86_400_000

/** Días seguidos, como el inicio (ms UTC) del primero y del último. */
export interface DayRange {
  from: number
  to: number
}

export interface MissingSignalView {
  signal: SignalId
  /** En cuántas monedas faltó. */
  coins: number
  /** Los días en que faltó en alguna moneda, en tramos de días seguidos. */
  ranges: DayRange[]
}

export interface SignalPairView {
  a: SignalId
  b: SignalId
  /** Correlación de Pearson; null sin datos suficientes. */
  rho: number | null
  /** En cuántas decisiones las dos tuvieron dato. */
  decisions: number
}

export interface UniverseChange {
  day: number
  added: string[]
  removed: string[]
}

export interface UniverseView {
  days: number
  min: number
  max: number
  /** Monedas distintas en todo el período. */
  distinct: number
  first: { day: number; symbols: string[] } | null
  /** Los días en que el universo cambió respecto del anterior. */
  changes: UniverseChange[]
}

export interface ReportCaveatsView {
  drawdownPause: DrawdownPause | null
  shadowOppositeSideCandles: number
  /**
   * Desde cuándo hubo interés abierto y ratios, si empezaron después del primer día; null si
   * estuvieron desde el principio o no hubo nunca (eso lo dicen las señales que faltaron).
   */
  futuresDataFrom: number | null
  /** Monedas con algún tramo sin vela de marca. */
  markFallbackCoins: number
  /** Operaciones del motor que fallaron y se saltearon. */
  failures: number
  /** Monedas cuyos datos Binance rechazó. */
  skipped: string[]
}

export interface ResumenReportView {
  fortnights: ReplayFortnight[]
  histogram: HistogramBin[]
  /** El umbral con que terminó el replay: la línea del histograma. */
  theta: number
  /** Los pares de señales, del más correlacionado (|ρ|) al menos; los sin dato al final. */
  pairs: SignalPairView[]
  universe: UniverseView
  missingSignals: MissingSignalView[]
  caveats: ReportCaveatsView
}

const dayOf = (at: number) => Math.floor(at / DAY_MS) * DAY_MS

/** Une los días de cada tramo (de todas las monedas) cuando se tocan o se pisan. */
function dayRanges(windows: readonly MissingSignalWindow[]): DayRange[] {
  const ranges: DayRange[] = []
  for (const { from, to } of [...windows].map((w) => ({ from: dayOf(w.from), to: dayOf(w.to) })).sort((a, b) => a.from - b.from)) {
    const last = ranges.at(-1)
    if (last && from <= last.to + DAY_MS) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }
  return ranges
}

/** Por señal, en el orden de las señales (`SIGNAL_IDS`). */
function missingSignals(windows: readonly MissingSignalWindow[]): MissingSignalView[] {
  return SIGNAL_IDS.flatMap((signal) => {
    const list = windows.filter((w) => w.signal === signal)
    return list.length === 0 ? [] : [{ signal, coins: new Set(list.map((w) => w.symbol)).size, ranges: dayRanges(list) }]
  })
}

function pairs({ signals, rho, pairs: counts }: ReplayReport['correlation']): SignalPairView[] {
  const out: SignalPairView[] = []
  signals.forEach((a, i) => {
    signals.forEach((b, j) => {
      if (j > i) out.push({ a, b, rho: rho[i]?.[j] ?? null, decisions: counts[i]?.[j] ?? 0 })
    })
  })
  const strength = (p: SignalPairView) => (p.rho === null ? -1 : Math.abs(p.rho))
  return out.sort((x, y) => strength(y) - strength(x))
}

function universe(byDay: ReplayReport['universeByDay']): UniverseView {
  // Las claves son días UTC "2026-08-02": en orden de texto, en orden de fecha.
  const days = Object.keys(byDay)
    .sort()
    .map((key) => ({ day: Date.parse(key), symbols: byDay[key] ?? [] }))
  const counts = days.map((d) => d.symbols.length)
  const changes: UniverseChange[] = []
  days.forEach(({ day, symbols }, i) => {
    const before = days[i - 1]?.symbols
    if (!before) return
    const added = symbols.filter((s) => !before.includes(s))
    const removed = before.filter((s) => !symbols.includes(s))
    if (added.length > 0 || removed.length > 0) changes.push({ day, added, removed })
  })
  const first = days[0]
  return {
    days: days.length,
    min: counts.length === 0 ? 0 : Math.min(...counts),
    max: counts.length === 0 ? 0 : Math.max(...counts),
    distinct: new Set(days.flatMap((d) => d.symbols)).size,
    first: first ? { day: first.day, symbols: first.symbols } : null,
    changes,
  }
}

/** Binance guarda 30 días de interés abierto y ratios: en un replay más largo, empiezan tarde. */
function lateFuturesData({ from, caveats }: ReplayReport): number | null {
  const at = caveats.futuresDataFrom
  return at !== null && at - from >= DAY_MS ? at : null
}

export function resumenReportView(report: ReplayReport, theta: number): ResumenReportView {
  return {
    fortnights: report.stats.real.byFortnight,
    histogram: report.signalHistogram,
    theta,
    pairs: pairs(report.correlation),
    universe: universe(report.universeByDay),
    missingSignals: missingSignals(report.missingSignalWindows),
    caveats: {
      drawdownPause: report.caveats.drawdownPause,
      shadowOppositeSideCandles: report.caveats.shadowOppositeSideCandles,
      futuresDataFrom: lateFuturesData(report),
      markFallbackCoins: new Set(report.missingMarkWindows.map((w) => w.symbol)).size,
      failures: report.failures.total,
      skipped: report.data.skipped.map((s) => s.symbol),
    },
  }
}
