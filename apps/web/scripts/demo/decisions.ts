import type { BlockReason, Composite, Decision, DecisionAction, SignalId } from '@sereno/core'
import { planEntry } from '@sereno/core/src/risk/sizing'
import type { Settings } from '@sereno/shared'
import type { BookResult } from './book'
import { BTC_SYMBOL, symbolInfo, type Coin } from './coins'
import { decisionKey, type ForwardReturn } from './dataset'
import { bookStateAt } from './equity'
import type { Market } from './market'
import { typicalAtrPct } from './plans'
import { rngFor, type Rng } from './random'
import { syntheticComposite } from './signals'
import { CYCLE_MS, DAY_MS, FOUR_HOURS_MS, HOUR_MS, STALE_DATA_MS } from './time'

// Las decisiones de cada ciclo, una por moneda (las últimas 24 horas en vivo, todas en
// un replay). El S′ de cada moneda es un proceso suave que a veces pasa θ; cuando pasa
// y no hubo entrada, la decisión lleva el primer motivo que la frenó, en el orden del
// motor: datos, penitencia, enfriamiento, posición abierta, filtros, tamaño y capacidad.

export type FilterBlock = Extract<BlockReason, 'higher_trend_against' | 'low_volume'>

export interface ForcedDecision {
  sPrime: number
  block?: FilterBlock
}

export interface DecisionInput {
  seed: number
  // Cada sesión tiene su propio S′ por moneda.
  sessionId: string
  capitalInicial: number
  coins: readonly Coin[]
  market: Market
  cycles: readonly number[]
  settingsAt: (t: number) => Settings
  real: BookResult
  composites: ReadonlyMap<string, Composite>
  // Moneda sin datos desde `since` (su último dato): el ciclo la ve degradada cuando
  // pasó más de STALE_DATA_MS, como el bot.
  degraded: { symbol: string; since: number } | null
  // S′ del último ciclo para mostrar cada motivo de bloqueo al menos una vez.
  forced: ReadonlyMap<string, ForcedDecision>
}

const AR_KEEP = 0.85
const AR_NOISE = 0.08
const NO_POSITIONING: SignalId[] = ['openInterest', 'positioning']

export function penaltyWindows(real: BookResult): Map<string, { from: number; until: number }> {
  const out = new Map<string, { from: number; until: number }>()
  for (const change of real.learning?.log ?? []) {
    if (change.kind !== 'penalty' || change.symbol === null) continue
    const until = (change.after as { penaltyUntil?: number }).penaltyUntil
    if (until !== undefined) out.set(change.symbol, { from: change.at, until })
  }
  return out
}

export function btcRegimeAt(market: Market, t: number): number {
  const now = market.priceAt(BTC_SYMBOL, t)
  const before = market.priceAt(BTC_SYMBOL, t - FOUR_HOURS_MS)
  return 0.5 * Math.tanh((now / before - 1) / 0.01)
}

function holdingAt(real: BookResult, symbol: string, t: number): BookResult['positions'][number] | undefined {
  return real.positions.find((p) => p.position.symbol === symbol && p.position.openedAt <= t && (p.closed === null || p.closed.closedAt > t))
}

interface Context {
  input: DecisionInput
  opening: Map<string, string>
  penalties: Map<string, { from: number; until: number }>
}

function blockFor(ctx: Context, coin: Coin, t: number): BlockReason | null {
  const { input } = ctx
  const symbol = coin.symbol
  if (input.degraded && input.degraded.symbol === symbol && t - input.degraded.since > STALE_DATA_MS) return 'degraded'
  const penalty = ctx.penalties.get(symbol)
  if (penalty && t >= penalty.from && t < penalty.until) return 'penalty'
  const settings = input.settingsAt(t)
  const cooldownMs = settings.entry.cooldownCandlesAfterLoss * CYCLE_MS
  const recentLoss = input.real.positions.some((p) => p.closed && p.position.symbol === symbol && p.closed.pnlNet < 0 && p.closed.closedAt <= t && t < p.closed.closedAt + cooldownMs)
  if (recentLoss) return 'cooldown'
  return holdingAt(input.real, symbol, t) ? 'has_position' : null
}

// Dimensiona con el capital de la cartera real en ese ciclo, como el motor: después
// del blindaje la base es la ganancia por encima de lo protegido.
function sizeBlock(coin: Coin, t: number, sPrime: number, ctx: Context): BlockReason | null {
  const { input } = ctx
  const settings = input.settingsAt(t)
  const price = input.market.priceAt(coin.symbol, t)
  const { capitalBase, capitalOperable } = bookStateAt(input.real, input.capitalInicial, settings, input.market, t)
  const result = planEntry({
    side: sPrime > 0 ? 'long' : 'short',
    price,
    atr1h: price * typicalAtrPct(coin),
    info: symbolInfo(coin),
    capitalBase,
    capitalOperable,
    settings,
    multipliers: { confidence: 1, symbol: 1, btc: 1 },
    theta: settings.entry.theta,
  })
  return result.ok ? null : result.reason
}

function decide(ctx: Context, coin: Coin, t: number, sPrime: number, forced: ForcedDecision | undefined, rng: Rng): Decision {
  const { input } = ctx
  const settings = input.settingsAt(t)
  const theta = settings.entry.theta
  const missing = coin.noPositioning ? NO_POSITIONING : []
  const base = { missing, adx: rng.between(22, 38), relVolume: rng.between(0.85, 1.3), higherTrendAgainst: 0 as const, btcRegime: btcRegimeAt(input.market, t) }
  const tradeId = ctx.opening.get(`${coin.symbol}|${t}`)
  const tradeComposite = tradeId === undefined ? undefined : input.composites.get(tradeId)
  const tradePlan = tradeId === undefined ? undefined : input.real.positions.find((p) => p.tradeId === tradeId)?.plan
  if (tradeComposite && tradePlan) {
    return { t, symbol: coin.symbol, composite: tradeComposite, action: { kind: 'enter', plan: tradePlan }, shadow: { Sprime: tradeComposite.Sprime, action: 'enter' } }
  }

  // Una moneda tranquila espera; los motivos de bloqueo son sólo para las que pasan θ.
  const wanted = Math.abs(sPrime) >= theta
  const state = wanted ? blockFor(ctx, coin, t) : null
  let composite: Composite
  let action: DecisionAction
  if (!wanted) {
    composite = syntheticComposite(rng, { ...base, sPrime })
    action = { kind: 'wait' }
  } else {
    const filter = forced?.block ?? (rng.next() < 0.55 ? 'higher_trend_against' : 'low_volume')
    const reason: BlockReason = state ?? sizeBlock(coin, t, sPrime, ctx) ?? filter
    const filtered = reason === 'higher_trend_against' ? { higherTrendAgainst: 2 as const } : reason === 'low_volume' ? { relVolume: rng.between(0.55, 0.75) } : {}
    composite = syntheticComposite(rng, { ...base, ...filtered, sPrime })
    action = { kind: 'blocked', reason, wantedSide: composite.Sprime >= 0 ? 'long' : 'short' }
  }
  // Pesos y parámetros de la sombra son los de la real mientras se juntan datos: decide lo mismo.
  return { t, symbol: coin.symbol, composite, action, shadow: { Sprime: composite.Sprime, action: action.kind } }
}

export function buildDecisions(input: DecisionInput): Decision[] {
  const opening = new Map<string, string>()
  for (const p of input.real.positions) {
    const trade = input.market.trades.get(p.tradeId)
    if (trade) opening.set(`${p.position.symbol}|${input.market.points.times[trade.plan.openIndex]}`, p.tradeId)
  }
  // El cierre por señal ocurre en el ciclo en que S′ cruza al otro lado más allá de θ/2.
  const flips = new Map<string, number>()
  for (const p of input.real.positions) {
    if (p.closed?.closeReason !== 'signal_flip') continue
    const cycle = p.closed.closedAt - (p.closed.closedAt % CYCLE_MS)
    flips.set(`${p.position.symbol}|${cycle}`, p.position.side === 'long' ? 1 : -1)
  }
  const ctx: Context = { input, opening, penalties: penaltyWindows(input.real) }
  const out: Decision[] = []
  const lastCycle = input.cycles[input.cycles.length - 1]
  for (const coin of input.coins) {
    const rng = rngFor(input.seed, 'decisiones', input.sessionId, coin.symbol)
    let x = rng.normal() * 0.15
    for (const t of input.cycles) {
      x = AR_KEEP * x + AR_NOISE * rng.normal()
      const forced = t === lastCycle ? input.forced.get(coin.symbol) : undefined
      let sPrime = Math.max(-0.95, Math.min(0.95, forced?.sPrime ?? x))
      const flip = flips.get(`${coin.symbol}|${t}`)
      const holding = holdingAt(input.real, coin.symbol, t)
      if (flip !== undefined && holding) {
        sPrime = -flip * holding.position.thetaAtOpen * 0.8
      } else if (holding) {
        // Con una posición abierta el S′ no cruza al lado opuesto más allá de θ/2: la
        // habría cerrado por señal, y el escenario decide cuándo cierra cada trade.
        const dir = holding.position.side === 'long' ? 1 : -1
        const limit = holding.position.thetaAtOpen / 2
        if (dir * sPrime < -limit * 0.9) sPrime = -dir * limit * 0.8
      }
      out.push(decide(ctx, coin, t, sPrime, forced, rng))
    }
  }
  return out.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol))
}

// Retorno a 4 h y a 24 h de cada decisión que ya los conoce en `knownUntil` (el job
// del bot los rellena cuando llegan las velas), por `símbolo|cierre de vela`.
export function forwardReturns(decisions: readonly Decision[], market: Market, knownUntil: number): Map<string, ForwardReturn> {
  const out = new Map<string, ForwardReturn>()
  for (const d of decisions) {
    if (d.t + FOUR_HOURS_MS > knownUntil) continue
    const at = market.priceAt(d.symbol, d.t)
    const ret = (h: number): number => market.priceAt(d.symbol, d.t + h) / at - 1
    out.set(decisionKey(d.symbol, d.t), d.t + DAY_MS <= knownUntil ? { forwardReturn4h: ret(FOUR_HOURS_MS), forwardReturn24h: ret(DAY_MS) } : { forwardReturn4h: ret(FOUR_HOURS_MS) })
  }
  return out
}
