import type { Candle, Composite } from '@sereno/core'
import type { CandleKey } from '@sereno/db'
import type { LearningOrigin } from '@sereno/shared'
import { simulateBook } from './book'
import { aggregate } from './candles'
import { COINS, type Coin } from './coins'
import type { DemoSession } from './dataset'
import { btcRegimeAt, buildDecisions, forwardReturns, type ForcedDecision } from './decisions'
import { equitySeries } from './equity'
import type { Market } from './market'
import { rngFor } from './random'
import { DEMO_SETTINGS, settingsAt, settingsTimeline } from './settings'
import { syntheticComposite } from './signals'
import { marketSymbols, universeDays } from './snapshot'
import type { SettingsChange, TradeSpec } from './spec'
import { alignDown, CYCLE_MS, DAY_MS, FOUR_HOURS_MS, HOUR_MS, lastSettledCycle, SECOND_MS, STALE_DATA_MS } from './time'

// Una simulación en vivo completa sobre el mercado del escenario: las dos carteras,
// decisiones del último día, curva de capital, snapshot de mercado, latido y
// aprendizaje.

export interface LiveSpec {
  id: string
  name: string
  capitalInicial: number
  startedAt: number
  learningOrigin: LearningOrigin
  settings: SettingsChange[]
  trades: TradeSpec[]
  degraded: { symbol: string; since: number } | null
  forced: ReadonlyMap<string, ForcedDecision>
}

export interface LiveContext {
  seed: number
  // Último instante en que el bot escribió (su último latido).
  botSeenAt: number
  market: Market
}

// Historia antes del arranque: los gráficos tienen velas previas a la primera entrada.
const WARMUP_MS = 2 * DAY_MS
const NO_POSITIONING = ['openInterest', 'positioning'] as const
// El bot reescribe el snapshot de mercado cada 5 s (el latido, cada 10 s).
const SNAPSHOT_EVERY_MS = 5 * SECOND_MS

// Desde dónde guarda velas la simulación: alineado a 4 h para que el marco mayor
// arranque con velas completas.
export function liveCandleStart(spec: LiveSpec): number {
  return alignDown(spec.startedAt - WARMUP_MS, FOUR_HOURS_MS)
}

export function tradeComposites(seed: number, trades: readonly TradeSpec[], market: Market, coins: readonly Coin[]): Map<string, Composite> {
  const bySymbol = new Map(coins.map((c) => [c.symbol, c]))
  return new Map(
    trades.map((t) => {
      const rng = rngFor(seed, 'compuesto', t.id)
      const coin = bySymbol.get(t.symbol)
      return [
        t.id,
        syntheticComposite(rng, {
          sPrime: (t.side === 'long' ? 1 : -1) * t.strength,
          missing: coin?.noPositioning ? [...NO_POSITIONING] : [],
          adx: rng.between(24, 38),
          relVolume: rng.between(1, 1.3),
          higherTrendAgainst: 0,
          btcRegime: btcRegimeAt(market, t.open),
        }),
      ]
    }),
  )
}

// Velas de 15m, 1h y 4h de último precio y de marca, de cada moneda desde `since`
// (las monedas que no están ahí no se guardan).
export function marketCandles(market: Market, since: ReadonlyMap<string, number>): { key: CandleKey; items: Candle[] }[] {
  const out: { key: CandleKey; items: Candle[] }[] = []
  for (const [symbol, all] of market.candles) {
    const from = since.get(symbol)
    if (from === undefined) continue
    const c15 = all.filter((c) => c.openTime >= from)
    const frames = [
      ['15m', c15],
      ['1h', aggregate(c15, HOUR_MS)],
      ['4h', aggregate(c15, FOUR_HOURS_MS)],
    ] as const
    for (const [timeframe, items] of frames) {
      out.push({ key: { symbol, timeframe, priceType: 'last' }, items })
      // En la demostración marca y último coinciden; Binance no da volumen de la marca.
      out.push({ key: { symbol, timeframe, priceType: 'mark' }, items: items.map((c) => ({ ...c, volume: 0, quoteVolume: 0 })) })
    }
  }
  return out
}

export function buildLive(spec: LiveSpec, ctx: LiveContext): DemoSession {
  const { seed, botSeenAt, market } = ctx
  const timeline = settingsTimeline(spec.settings)
  const at = settingsAt(timeline)
  const composites = tradeComposites(seed, spec.trades, market, COINS)
  const bookInput = { seed, capitalInicial: spec.capitalInicial, settingsAt: at, market, composites, start: spec.startedAt, end: botSeenAt }
  const real = simulateBook({ ...bookInput, kind: 'real', idPrefix: `pos_${spec.id}_` })
  const shadow = simulateBook({ ...bookInput, kind: 'shadow', idPrefix: `pos_${spec.id}_` })

  const lastCycle = lastSettledCycle(botSeenAt)
  const cycles: number[] = []
  for (let t = lastCycle; t > botSeenAt - DAY_MS && t > spec.startedAt; t -= CYCLE_MS) cycles.unshift(t)
  const decisions = buildDecisions({ seed, sessionId: spec.id, capitalInicial: spec.capitalInicial, coins: COINS, market, cycles, settingsAt: at, real, composites, degraded: spec.degraded, forced: spec.forced })

  const current = timeline[timeline.length - 1]
  if (!current) throw new Error('Sin ajustes')
  const degradedNow = spec.degraded !== null && botSeenAt - spec.degraded.since > STALE_DATA_MS ? spec.degraded : null
  return {
    row: {
      id: spec.id,
      kind: 'paper_live',
      name: spec.name,
      status: 'active',
      capitalInicial: spec.capitalInicial,
      baseBlindaje: real.shield?.baseBlindaje ?? spec.capitalInicial,
      protegido: real.shield?.protegido ?? 0,
      settingsSnapshot: DEMO_SETTINGS,
      learningOrigin: spec.learningOrigin,
      startedAt: new Date(spec.startedAt),
    },
    settings: timeline,
    universe: universeDays(seed, COINS, spec.startedAt, botSeenAt),
    books: { real, shadow },
    decisions,
    forwardReturns: forwardReturns(decisions, market, lastCycle),
    equity: equitySeries({ capitalInicial: spec.capitalInicial, settingsAt: at, market, real, shadow, start: spec.startedAt, end: botSeenAt, minuteTailMs: DAY_MS }),
    marketSnapshot: {
      updatedAt: botSeenAt,
      // Sube en cada escritura del snapshot.
      version: Math.floor((botSeenAt - spec.startedAt) / SNAPSHOT_EVERY_MS),
      symbols: marketSymbols({ coins: COINS, market, at: botSeenAt, decisions, real, settings: current.config, degraded: degradedNow }),
    },
    bot: {
      status: {
        sessionId: spec.id,
        instanceId: 'mac-toti-7f3a9c',
        lastHeartbeat: new Date(botSeenAt),
        phase: 'live',
        warmProgress: COINS.length,
        universeSize: COINS.length,
        // El bot guarda el cierre de vela del ciclo, no cuándo terminó de ejecutarlo.
        lastCycleAt: new Date(lastCycle),
        settingsVersionApplied: current.version,
        degradedSymbols: degradedNow ? [degradedNow.symbol] : [],
        flags: { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false },
        recentErrors: degradedNow
          ? [{ at: new Date(degradedNow.since).toISOString(), message: `Dejaron de llegar velas de ${degradedNow.symbol}: la marco sin datos`, context: 'market-stream' }]
          : [],
        botVersion: '0.1.0',
      },
      lease: { sessionId: spec.id, instanceId: 'mac-toti-7f3a9c', leaseUntil: new Date(botSeenAt + 30 * SECOND_MS) },
    },
    learning: real.learning,
  }
}
