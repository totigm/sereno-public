import type { AccountSnapshot, ClosedPosition, Composite, EntryPlan, Position } from '@sereno/core'
import { Account } from '@sereno/core/src/capital/account'
import { fillPrice, slippageForNotional } from '@sereno/core/src/exchange/fills'
import { closingSide, direction } from '@sereno/core/src/exchange/sides'
import { phraseClose, phraseOpen, phraseStopMoved } from '@sereno/core/src/journal/phrases'
import { learnFromClosedTrade } from '@sereno/core/src/learning/closed-trade'
import { isPenalized, symbolMultiplier } from '@sereno/core/src/learning/confidence'
import type { LearningChange } from '@sereno/core/src/learning/state'
import { checkCapacity } from '@sereno/core/src/risk/account-rules'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import { planEntry } from '@sereno/core/src/risk/sizing'
import { sizingConfidence } from '@sereno/core/src/signals/modifiers'
import type { LearningState } from '@sereno/core'
import type { PositionEventInput } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import { EntryRules } from './book-rules'
import { fundingRate, fundingTimes } from './funding'
import type { Market, TradeMarket, TradeOutcome } from './market'
import { demoLearningState } from './settings'
import { CYCLE_SETTLE_MS } from './time'

// Una cartera (la real o la sombra) recorrida en orden cronológico con las fórmulas
// de core: tamaño con `planEntry` sobre el capital base del momento, fills con
// spread y slippage, comisiones, funding, blindaje con `Account` y, en la real, el
// aprendizaje con `learnFromClosedTrade`. Los montos en US$ quedan en centavos.

export type BookKind = 'real' | 'shadow'

export interface BookInput {
  kind: BookKind
  idPrefix: string
  seed: number
  capitalInicial: number
  settingsAt: (t: number) => Settings
  market: Market
  composites: ReadonlyMap<string, Composite>
  start: number
  end: number
}

export interface BookPosition {
  tradeId: string
  position: Position
  closed: ClosedPosition | null
  plan: EntryPlan
  closePhrase: string | null
  latencyMs: number
  events: PositionEventInput[]
}

export interface LedgerEntry {
  at: number
  amount: number
}

export interface ShieldEvent {
  at: number
  protegido: number
  baseBlindaje: number
}

export interface BookResult {
  positions: BookPosition[]
  ledger: LedgerEntry[]
  shield: ShieldEvent | null
  learning: { state: LearningState; log: LearningChange[] } | null
  final: AccountSnapshot
}

// El cierre por blindaje sale en el mismo ciclo en que se dispara.
const MAX_COMMAND_LAG_MS = 60_000

export const cents = (x: number): number => Math.round(x * 100) / 100 + 0

type BookEvent =
  | { at: number; order: 0; kind: 'funding'; tradeId: string }
  | { at: number; order: 1; kind: 'move'; tradeId: string; move: TradeOutcome['moves'][number] }
  | { at: number; order: 2; kind: 'close'; tradeId: string }
  | { at: number; order: 3; kind: 'shield' }
  | { at: number; order: 4; kind: 'open'; tradeId: string }

interface OpenState {
  trade: TradeMarket
  outcome: TradeOutcome
  position: Position
  plan: EntryPlan
  openSpread: number
  openSlippage: number
  latencyMs: number
  events: PositionEventInput[]
  orderSeq: number
}

function outcomeOf(kind: BookKind, trade: TradeMarket): TradeOutcome {
  return kind === 'real' ? trade.real : trade.shadow
}

// Los trades de la sesión son los suyos (los que tienen compuesto) que abren dentro de
// ella: el mercado es compartido con las otras sesiones del escenario, que pueden correr
// al mismo tiempo (la de plata real toma algunos de los trades de la simulación).
function scheduledEvents(input: BookInput): BookEvent[] {
  const events: BookEvent[] = []
  for (const [tradeId, trade] of input.market.trades) {
    if (!input.composites.has(tradeId) || trade.openedAt < input.start || trade.openedAt > input.end) continue
    const outcome = outcomeOf(input.kind, trade)
    const until = outcome.exit?.at ?? input.end
    events.push({ at: trade.openedAt, order: 4, kind: 'open', tradeId })
    if (outcome.exit) events.push({ at: outcome.exit.at, order: 2, kind: 'close', tradeId })
    for (const move of outcome.moves) events.push({ at: move.at, order: 1, kind: 'move', tradeId, move })
    for (const at of fundingTimes(trade.plan.coin, trade.openedAt, Math.min(until, input.end))) events.push({ at, order: 0, kind: 'funding', tradeId })
  }
  // El blindaje se mira en cada ciclo que terminó de ejecutar antes del final.
  const { times, lastBoundary } = input.market.points
  for (let i = 0; i <= lastBoundary; i++) {
    const at = times[i] ?? 0
    if (at > input.start && at + CYCLE_SETTLE_MS <= input.end) events.push({ at, order: 3, kind: 'shield' })
  }
  const late = events.find((e) => e.at > input.end)
  if (late) throw new Error(`Escenario incoherente (${input.kind}): un evento ${late.kind} cae después del final (${new Date(input.end).toISOString()})`)
  return events.sort((a, b) => a.at - b.at || a.order - b.order)
}

export function simulateBook(input: BookInput): BookResult {
  const { kind, market, settingsAt } = input
  const first = settingsAt(input.start)
  const account = new Account({
    capitalInicial: input.capitalInicial,
    reinvest: first.capital.reinvest,
    protectPct: first.capital.protectPct,
    onShield: first.capital.onShield,
  })
  const rules = new EntryRules(kind)
  const open = new Map<string, OpenState>()
  const positions: BookPosition[] = []
  const ledger: LedgerEntry[] = []
  let shield: ShieldEvent | null = null
  let learning = kind === 'real' ? { state: demoLearningState(input.start), log: [] as LearningChange[] } : null
  // Trades de la real que el blindaje mandó cerrar, con el ciclo en que se disparó.
  const shieldClosed = new Map<string, number>()

  const realize = (at: number, amount: number): void => {
    if (amount === 0) return
    account.applyRealized(amount)
    ledger.push({ at, amount })
  }
  const marks = (at: number): Record<string, number> =>
    Object.fromEntries([...open.values()].map((s) => [s.position.symbol, market.priceAt(s.position.symbol, at)]))
  const snapshot = (at: number): AccountSnapshot => account.snapshot([...open.values()].map((s) => s.position), marks(at))
  const syncSettings = (s: Settings): void => {
    account.setReinvest(s.capital.reinvest)
    account.setProtectPct(s.capital.protectPct)
    account.setOnShield(s.capital.onShield)
  }

  const openTrade = (tradeId: string, at: number): void => {
    const trade = market.trades.get(tradeId)
    const composite = input.composites.get(tradeId)
    if (!trade || !composite) throw new Error(`Falta el mercado o el compuesto del trade ${tradeId}`)
    const { plan: tp } = trade
    const { coin, info } = tp
    const s = settingsAt(at)
    syncSettings(s)
    const snap = snapshot(at)
    rules.assertCanOpen(tradeId, coin.symbol, at, snap.capitalBase, s)
    if (learning && isPenalized(learning.state, coin.symbol, at)) throw new Error(`Escenario incoherente: ${tradeId} abre en penitencia`)
    const multipliers = {
      confidence: 0.6 + 0.4 * sizingConfidence(composite),
      symbol: learning ? symbolMultiplier(learning.state, coin.symbol, at) : 1,
      btc: 1,
    }
    const result = planEntry({
      side: tp.spec.side,
      price: tp.ref,
      atr1h: tp.atr1h,
      info,
      capitalBase: snap.capitalBase,
      capitalOperable: snap.capitalOperable,
      settings: s,
      multipliers,
      theta: s.entry.theta,
    })
    if (!result.ok) throw new Error(`Escenario incoherente (${kind}): ${tradeId} no se puede abrir (${result.reason})`)
    const plan = result.plan
    if (plan.stopPrice !== tp.levels.stop || plan.takeProfitPrice !== tp.levels.tp) throw new Error(`Niveles distintos en ${tradeId}`)
    const others = [...open.values()].map((o) => o.position)
    const capacity = checkCapacity({ open: others, side: plan.side, plan, capitalBase: snap.capitalBase, capitalOperable: snap.capitalOperable, mode: s.mode, settings: s })
    if (capacity !== null) throw new Error(`Escenario incoherente (${kind}): ${tradeId} choca con ${capacity}`)

    const fill = fillPrice({ lastPrice: tp.ref, halfSpreadRate: info.halfSpreadRate, slippageRate: s.risk.slippageRate, notional: plan.qty * tp.ref, side: plan.side === 'long' ? 'buy' : 'sell' })
    if (fill.price !== tp.levels.entry) throw new Error(`El trade ${tradeId} pasó los 10.000 USDT: el slippage cambia entre carteras`)
    const fee = cents(fill.price * plan.qty * s.risk.takerFeeRate)
    const notional = fill.price * plan.qty
    const id = `${input.idPrefix}${kind === 'shadow' ? 's' : 'r'}-${tradeId}`
    const position: Position = {
      id,
      symbol: coin.symbol,
      side: plan.side,
      leverage: plan.leverage,
      margin: cents(notional / plan.leverage),
      notional: cents(notional),
      qty: plan.qty,
      entryPrice: fill.price,
      openedAt: at,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
      liquidationPrice: liquidationPrice(plan.side, fill.price, plan.leverage, info.mmr),
      distanciaStop: plan.distanciaStop,
      riesgoReal: cents(plan.riesgoReal),
      thetaAtOpen: plan.theta,
      trailingActive: false,
      bestPrice: fill.price,
      stopOrderId: `${id}-sl1`,
      tpOrderId: plan.takeProfitPrice === null ? null : `${id}-tp`,
      feesPaid: fee,
      fundingPaid: 0,
      shadow: kind === 'shadow',
      openReason: '',
      signalsAtOpen: composite.signals,
      mode: s.mode,
    }
    position.openReason = phraseOpen(position, composite)
    realize(at, -fee)
    const latencyMs = at - (market.points.times[tp.openIndex] ?? at)
    const events: PositionEventInput[] = [
      {
        kind: 'open',
        at,
        payload: { price: fill.price, qty: plan.qty, leverage: plan.leverage, margin: position.margin, fee, lastPrice: tp.ref, markPrice: tp.ref, spread: cents(fill.spreadCost), slippage: cents(fill.slippageCost), latencyMs, phrase: position.openReason },
      },
      { kind: 'order_placed', at, payload: { orderId: position.stopOrderId, type: 'STOP_MARKET', stopPrice: plan.stopPrice } },
    ]
    if (position.tpOrderId) events.push({ kind: 'order_placed', at, payload: { orderId: position.tpOrderId, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.takeProfitPrice } })
    open.set(tradeId, { trade, outcome: outcomeOf(kind, trade), position, plan, openSpread: fill.spreadCost, openSlippage: fill.slippageCost, latencyMs, events, orderSeq: 1 })
  }

  const applyFunding = (state: OpenState, at: number): void => {
    const { position, trade } = state
    const rate = fundingRate(input.seed, trade.plan.coin, at)
    const mark = market.priceAt(position.symbol, at)
    // Como el motor: positivo cobra, negativo paga (spec §6); el long paga con tasa positiva.
    const received = cents(-direction(position.side) * position.qty * mark * rate)
    if (received === 0) return
    position.fundingPaid = cents(position.fundingPaid - received)
    realize(at, received)
    // El payload sigue el contrato del bot (`apps/bot/src/live/payloads.ts`): positivo = pagado, como `fundingPaid`.
    state.events.push({ kind: 'funding', at, payload: { rate, markPrice: mark, amount: cents(-received) } })
  }

  const moveStop = (state: OpenState, move: TradeOutcome['moves'][number]): void => {
    const { position } = state
    const previous = position.stopOrderId
    state.orderSeq++
    position.stopOrderId = `${position.id}-sl${state.orderSeq}`
    position.stopPrice = move.to
    position.trailingActive = true
    state.events.push(
      { kind: 'order_cancelled', at: move.at, payload: { orderId: previous, type: 'STOP_MARKET' } },
      { kind: 'order_placed', at: move.at, payload: { orderId: position.stopOrderId, type: 'STOP_MARKET', stopPrice: move.to } },
      { kind: 'stop_moved', at: move.at, payload: { from: move.from, to: move.to, phrase: phraseStopMoved(position, move.from, move.to) } },
    )
  }

  const closeTrade = (state: OpenState, reason: ClosedPosition['closeReason'], at: number, price: number): void => {
    const { position, outcome } = state
    const s = settingsAt(at)
    const conditional = reason === 'stop' || reason === 'take_profit' || reason === 'trailing_stop'
    const exitNotional = position.qty * price
    const fill = fillPrice({
      lastPrice: price,
      halfSpreadRate: state.trade.plan.info.halfSpreadRate,
      slippageRate: s.risk.slippageRate,
      notional: exitNotional,
      side: closingSide(position.side),
      adverseExtra: conditional ? slippageForNotional(s.risk.slippageRate, exitNotional) : 0,
    })
    const closeFee = cents(fill.price * position.qty * s.risk.takerFeeRate)
    const pnlGross = cents(direction(position.side) * (fill.price - position.entryPrice) * position.qty)
    realize(at, cents(pnlGross - closeFee))
    const fees = cents(position.feesPaid + closeFee)
    const pnlNet = cents(pnlGross - fees - position.fundingPaid)
    const closed: ClosedPosition = {
      ...position,
      feesPaid: fees,
      bestPrice: outcome.best,
      closedAt: at,
      exitPrice: fill.price,
      closeReason: reason,
      pnlGross,
      pnlNet,
      rMultiple: pnlNet / position.riesgoReal,
      costs: {
        fees,
        spread: cents(state.openSpread + fill.spreadCost),
        slippage: cents(state.openSlippage + fill.slippageCost),
        funding: position.fundingPaid,
      },
    }
    const phrase = phraseClose(closed)
    const cancelled = [
      reason === 'stop' || reason === 'trailing_stop' ? null : { orderId: position.stopOrderId, type: 'STOP_MARKET' },
      reason === 'take_profit' || position.tpOrderId === null ? null : { orderId: position.tpOrderId, type: 'TAKE_PROFIT_MARKET' },
    ].filter((o) => o !== null)
    for (const order of cancelled) state.events.push({ kind: 'order_cancelled', at, payload: order })
    state.events.push({ kind: 'close', at, payload: { reason, price: fill.price, fee: closeFee, pnlGross, pnlNet, rMultiple: closed.rMultiple, phrase } })
    open.delete(state.trade.plan.spec.id)
    rules.recordClose(closed)
    if (learning) {
      const learned = learnFromClosedTrade(learning.state, closed, s.learning, at)
      learning = { state: learned.state, log: [...learning.log, ...learned.log] }
    }
    positions.push({ tradeId: state.trade.plan.spec.id, position: closed, closed, plan: state.plan, closePhrase: phrase, latencyMs: state.latencyMs, events: state.events })
  }

  const checkShield = (at: number): void => {
    syncSettings(settingsAt(at))
    const check = account.checkShield([...open.values()].map((o) => o.position), marks(at))
    if (!check.triggered) return
    const snap = snapshot(at)
    shield = { at, protegido: snap.protegido, baseBlindaje: snap.baseBlindaje }
    for (const p of check.toClose) {
      const entry = [...open.entries()].find(([, o]) => o.position.id === p.id)
      if (!entry) continue
      const [tradeId, state] = entry
      if (kind === 'real') {
        // La real sigue al escenario: el cierre ya está programado como `shield_reduce`.
        if (state.outcome.exit?.reason !== 'shield_reduce') throw new Error(`Escenario incoherente: el blindaje (${new Date(at).toISOString()}) cierra ${tradeId}, que no lo esperaba; cierra ${check.toClose.map((c) => c.id).join(', ')}`)
        shieldClosed.set(tradeId, at)
      } else {
        // En la sombra el blindaje se resuelve solo, a mercado en el mismo ciclo.
        closeTrade(state, 'shield_reduce', at + state.latencyMs, market.priceAt(p.symbol, at))
      }
    }
  }

  for (const event of scheduledEvents(input)) {
    if (event.kind === 'shield') {
      checkShield(event.at)
      continue
    }
    if (event.kind === 'open') {
      openTrade(event.tradeId, event.at)
      continue
    }
    const state = open.get(event.tradeId)
    if (!state) continue
    if (event.kind === 'funding') applyFunding(state, event.at)
    else if (event.kind === 'move') moveStop(state, event.move)
    else {
      const exit = state.outcome.exit
      if (!exit) continue
      const firedAt = shieldClosed.get(event.tradeId)
      if (exit.reason === 'shield_reduce' && (firedAt === undefined || exit.at - firedAt > MAX_COMMAND_LAG_MS)) {
        throw new Error(`Escenario incoherente: ${event.tradeId} esperaba el blindaje en ese ciclo y no se disparó`)
      }
      closeTrade(state, exit.reason, exit.at, exit.price)
    }
  }

  for (const [tradeId, state] of open) {
    const { position, outcome } = state
    const current: Position = { ...position, bestPrice: outcome.best, trailingActive: outcome.trailingActive, stopPrice: outcome.stop }
    positions.push({ tradeId, position: current, closed: null, plan: state.plan, closePhrase: null, latencyMs: state.latencyMs, events: state.events })
  }
  positions.sort((a, b) => a.position.openedAt - b.position.openedAt)
  return { positions, ledger, shield, learning, final: snapshot(input.end) }
}
