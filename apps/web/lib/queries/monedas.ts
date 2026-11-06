import { cache } from 'react'
import type { BlockReason, Candle, SignalId, SignalResult } from '@sereno/core'
import { isPenalized, symbolConfidence, symbolMultiplier } from '@sereno/core/src/learning/confidence'
import { effectiveWeights } from '@sereno/core/src/learning/weights'
import { computeStats, type SymbolStats } from '@sereno/core/src/stats/stats'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { DecisionActionLabel, DecisionRecord, UniverseExcluded } from '@sereno/db'
import { repos } from '../db'
import type { LivePayload } from '../live/types'
import { getBooks, getLearning, getLive } from './books'
import { anchorOf, getSessionView, type SessionView } from './session'

export interface CoinDecisionView {
  /** Cierre de la vela evaluada. */
  at: number
  S: number
  Sprime: number
  signals: SignalResult[]
  missingSignals: SignalId[]
  action: DecisionActionLabel
  blockedBy: BlockReason | null
}

export interface CoinInfo {
  symbol: string
  /** "PEPE" para 1000PEPEUSDT: sin cotización ni prefijo de multiplicador. */
  name: string
  /** La última decisión del bot sobre la moneda: el puntaje desglosado por señal de la hoja. */
  decision: CoinDecisionView | null
  /** Pesos efectivos de la moneda (global encogido hacia el propio, spec §8). */
  weights: Record<SignalId, number>
  /** Confianza aprendida vigente (−1…1) y su multiplicador de tamaño (0,5…1). */
  confidence: number
  multiplier: number
  /** Trades cerrados que cuentan para el aprendizaje de la moneda. */
  learnedTrades: number
  /** Hasta cuándo está en penitencia; null si no lo está. */
  penaltyUntil: number | null
  /** Estadísticas de la cartera real en la moneda; null si no tuvo trades. */
  stats: SymbolStats | null
  pinned: boolean
  excluded: boolean
}

export interface CoinDetail {
  symbol: string
  /** Velas de 15 m (último precio) de las últimas 48 h. */
  candles: Candle[]
}

export interface MonedasData {
  session: SessionView
  /** Precios, estados de las baldosas y abiertas (dato inicial de `LiveProvider`). */
  live: LivePayload
  /** Una por moneda del tablero o con posición abierta, por símbolo. */
  coins: Record<string, CoinInfo>
  /** Las que quedaron afuera del último universo del día, con su motivo (vacío si todavía no hay ninguno). */
  excluded: UniverseExcluded
  /** La moneda de `?moneda=`, con su gráfico. */
  detail: CoinDetail | null
  /** El umbral de entrada de la cartera real (`learning.params.theta`, spec §5.4 y §8). */
  theta: number
}

const HOUR_MS = 3_600_000
const DECISION_LOOKBACK_MS = 2 * HOUR_MS
const CHART_MS = 48 * HOUR_MS

export const getMonedasData = cache(async (sessionId: string, selected?: string): Promise<MonedasData | null> => {
  const [session, live] = await Promise.all([getSessionView(sessionId), getLive(sessionId)])
  if (!session || !live) return null
  // Las decisiones del último ciclo están junto al último snapshot de precios.
  const anchor = live.market?.updatedAt ?? anchorOf(session, live.now)
  const [books, learning, decisions, universeDay] = await Promise.all([
    getBooks(sessionId),
    getLearning(sessionId, session.startedAt),
    repos.decisions.range(sessionId, anchor - DECISION_LOOKBACK_MS, anchor + 1),
    repos.universeDays.latest(sessionId),
  ])
  const latest = latestBySymbol(decisions)
  const bySymbol = computeStats(books.real, []).bySymbol
  const universe = live.settings?.universe
  const symbols = new Set([...(live.market?.symbols ?? []).map((s) => s.symbol), ...live.open.map((p) => p.symbol)])
  const now = anchorOf(session, live.now)
  const shrinkageK = live.settings?.learning.shrinkageK

  const coins: Record<string, CoinInfo> = {}
  for (const symbol of symbols) {
    const decision = latest.get(symbol)
    coins[symbol] = {
      symbol,
      name: coinName(symbol),
      decision: decision ? toDecisionView(decision) : null,
      weights: effectiveWeights(learning.state, symbol, shrinkageK),
      confidence: symbolConfidence(learning.state, symbol, now),
      multiplier: symbolMultiplier(learning.state, symbol, now),
      learnedTrades: learning.state.tradesBySymbol[symbol] ?? 0,
      penaltyUntil: isPenalized(learning.state, symbol, now) ? (learning.state.penalties[symbol] ?? null) : null,
      stats: bySymbol[symbol] ?? null,
      pinned: universe?.pinned.includes(symbol) ?? false,
      excluded: universe?.excluded.includes(symbol) ?? false,
    }
  }

  const detail =
    selected !== undefined && symbols.has(selected)
      ? { symbol: selected, candles: await repos.candles.range(selected, '15m', 'last', anchor - CHART_MS, anchor + 1) }
      : null
  return { session, live, coins, excluded: universeDay?.excluded ?? {}, detail, theta: learning.state.params.theta }
})

function latestBySymbol(decisions: DecisionRecord[]): Map<string, DecisionRecord> {
  // `range` viene en orden: la última que se escribe por símbolo es la más nueva.
  return new Map(decisions.map((d) => [d.symbol, d]))
}

function toDecisionView(d: DecisionRecord): CoinDecisionView {
  return {
    at: d.candleCloseTime,
    S: d.s,
    Sprime: d.sPrime,
    signals: d.signals,
    missingSignals: d.missingSignals,
    action: d.action,
    blockedBy: d.blockedBy,
  }
}
