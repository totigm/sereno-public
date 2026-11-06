import type { ClosedPosition } from '@sereno/core'
import { computeStats, type Stats } from '@sereno/core/src/stats/stats'
import { verdict, type Verdict } from '@sereno/core/src/stats/verdict'
import type { EquityPoint } from '@sereno/db'
import type { BookResult } from './book'
import type { DemoSession } from './dataset'
import { createRng, seedFrom } from './random'
import { DAY_MS } from './time'

// Estadísticas y veredicto de cada cartera por separado, con las funciones de core
// (las mismas que usa el dashboard): la real nunca se mezcla con la sombra.

// Spec §11.6: el veredicto se evalúa a partir de 100 trades cerrados y 30 días.
export const VERDICT_MIN_TRADES = 100
export const VERDICT_MIN_DAYS = 30

const closedOf = (book: BookResult): ClosedPosition[] => book.positions.flatMap((p) => (p.closed ? [p.closed] : []))

export interface BookSummary {
  stats: Stats
  verdict: Verdict
}

export interface VerdictInput {
  seed: number
  days: number
  real: BookResult
  shadow: BookResult
  equity: readonly EquityPoint[]
  capitalInicial: number
}

function summarize(input: VerdictInput, kind: 'real' | 'shadow'): BookSummary {
  const book = input[kind]
  const closed = closedOf(book)
  const series = input.equity.map((p) => ({ at: p.at, equity: kind === 'real' ? p.equity : (p.shadowEquity ?? p.equity) }))
  const stats = computeStats(closed, series)
  const gap = kind === 'real' ? ((input.real.final.equity - input.shadow.final.equity) / input.capitalInicial) * 100 : undefined
  const result = verdict(closed, input.days, {
    minTrades: VERDICT_MIN_TRADES,
    minDays: VERDICT_MIN_DAYS,
    maxDrawdownPct: stats.maxDrawdownPct,
    rng: createRng(seedFrom(input.seed, 'veredicto', kind)).next,
    ...(gap === undefined ? {} : { shadowGapPp: gap }),
  })
  return { stats, verdict: result }
}

export function replayVerdict(input: VerdictInput): Verdict {
  return summarize(input, 'real').verdict
}

export interface SessionSummary {
  real: BookSummary
  shadow: BookSummary
}

export function sessionSummary(session: DemoSession, seed: number, now: number): SessionSummary | null {
  if (!session.books) return null
  const end = session.row.endedAt instanceof Date ? session.row.endedAt.getTime() : now
  const started = session.row.startedAt instanceof Date ? session.row.startedAt.getTime() : now
  const days = session.row.kind === 'replay' ? (session.row.replayParams?.days ?? 0) : (end - started) / DAY_MS
  const input = { seed, days, ...session.books, equity: session.equity, capitalInicial: session.row.capitalInicial }
  return { real: summarize(input, 'real'), shadow: summarize(input, 'shadow') }
}
