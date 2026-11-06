import type { ClosedPosition } from '../types'
import { DAY_MS } from './state'

// Comparación entre lo aprendido y la cartera sombra (spec §8, "Sombra"): brecha
// de retorno en puntos porcentuales del capital inicial y suma de R en la ventana.

export interface EquityPoint {
  at: number
  equity: number
}

export interface PortfolioTrack {
  equity: EquityPoint[]
  trades: Pick<ClosedPosition, 'closedAt' | 'rMultiple'>[]
}

export interface ShadowComparison {
  from: number
  to: number
  learnedPp: number
  shadowPp: number
  // Positivo = la sombra va ganando.
  gapPp: number
  sumRLearned: number
  sumRShadow: number
  tradesLearned: number
  tradesShadow: number
  enoughTrades: boolean
  warn: boolean
}

export const SHADOW_MIN_TRADES = 20
export const SHADOW_WARN_PP = 3
// Tolerancia para que 7 − 4 en coma flotante no cuente como "más de 3".
const EPS = 1e-9

// Equity vigente en `t`: el último punto hasta `t` o, si todos son posteriores,
// el primero (la cartera arrancó dentro de la ventana).
function equityAt(points: EquityPoint[], t: number): number | null {
  let last: EquityPoint | null = null
  for (const p of points) {
    if (p.at <= t) {
      if (last === null || p.at >= last.at) last = p
    }
  }
  if (last !== null) return last.equity
  let first: EquityPoint | null = null
  for (const p of points) if (first === null || p.at < first.at) first = p
  return first?.equity ?? null
}

function returnPp(points: EquityPoint[], from: number, to: number, capitalInicial: number): number {
  const start = equityAt(points, from)
  const end = equityAt(points, to)
  if (start === null || end === null) return 0
  return ((end - start) / capitalInicial) * 100
}

function inWindow(track: PortfolioTrack, from: number, to: number): PortfolioTrack['trades'] {
  return track.trades.filter((t) => t.closedAt >= from && t.closedAt <= to)
}

function lastAt(points: EquityPoint[]): number | null {
  let max: number | null = null
  for (const p of points) if (max === null || p.at > max) max = p.at
  return max
}

export function compareShadow(
  learned: PortfolioTrack,
  shadow: PortfolioTrack,
  capitalInicial: number,
  days: number = 14,
  now?: number,
): ShadowComparison {
  const to = now ?? Math.max(lastAt(learned.equity) ?? 0, lastAt(shadow.equity) ?? 0)
  const from = to - days * DAY_MS
  const learnedPp = returnPp(learned.equity, from, to, capitalInicial)
  const shadowPp = returnPp(shadow.equity, from, to, capitalInicial)
  const learnedTrades = inWindow(learned, from, to)
  const shadowTrades = inWindow(shadow, from, to)
  const gapPp = shadowPp - learnedPp
  const enoughTrades = learnedTrades.length >= SHADOW_MIN_TRADES && shadowTrades.length >= SHADOW_MIN_TRADES
  return {
    from,
    to,
    learnedPp,
    shadowPp,
    gapPp,
    sumRLearned: learnedTrades.reduce((acc, t) => acc + t.rMultiple, 0),
    sumRShadow: shadowTrades.reduce((acc, t) => acc + t.rMultiple, 0),
    tradesLearned: learnedTrades.length,
    tradesShadow: shadowTrades.length,
    enoughTrades,
    warn: enoughTrades && gapPp - SHADOW_WARN_PP > EPS,
  }
}
