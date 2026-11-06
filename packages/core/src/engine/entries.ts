import type { Settings } from '@sereno/shared'
import type { Marks } from '../capital/account'
import type { OrderRejectReason } from '../exchange/errors'
import { atr } from '../indicators/atr'
import { checkCapacity } from '../risk/account-rules'
import { checkLossFloor } from '../risk/loss-floor'
import { planCustomEntry, planEntry, type PlanResult } from '../risk/sizing'
import { entryFilters } from '../signals/filters'
import { btcVolatilityMultiplier, sizingConfidence } from '../signals/modifiers'
import type { BlockReason, Composite, DecisionAction, MarketView, Side } from '../types'
import type { Portfolio } from './portfolio'
import type { Opening } from './position-manager'

// Entradas de un ciclo para una cartera (spec §5.3–§5.5): las candidatas por confianza,
// y para cada una la pausa, el umbral, el corte de cuenta, los filtros, el plan, la
// capacidad, el tope de pérdida (sólo de lo real) y la orden.

export interface Scored {
  view: MarketView
  composite: Composite
}

export interface EntryOutcome {
  action: DecisionAction
  // Bloqueo propio de la moneda (filtro, plan o capacidad) que el diario cuenta como
  // "esperé". Las pausas de cuenta tienen su propio aviso y la vela faltante o la
  // posición ya abierta no dicen nada nuevo.
  journal: boolean
}

export interface EntryPass {
  portfolio: Portfolio
  // Los ajustes con que decide la cartera (`portfolio.settings(...)`).
  settings: Settings
  candidates: readonly Scored[]
  // Pausa de la sesión (spec §7): no se evalúan entradas, todas quedan `paused`.
  paused: boolean
  // Corte de cuenta vigente: bloquea toda entrada que pase θ.
  gate: BlockReason | null
  missing: ReadonlySet<string>
  degraded: ReadonlySet<string>
  now: number
  marks: Marks
  onOpened: (opening: Opening) => void
  // La orden no salió por una falla (no por una regla del exchange): no se abrió nada.
  onFailed: (symbol: string, error: unknown) => void
}

// ATR(14) de Wilder en 1h: el único ATR del tamaño y del stop (spec §5.2).
const ATR_PERIOD = 14
// mConfianza = 0,6 + 0,4·c (spec §5.5).
const CONFIDENCE_FLOOR = 0.6
const CONFIDENCE_SLOPE = 0.4
// Motivos de filtro que no son noticia para el diario.
const QUIET_FILTERS: ReadonlySet<BlockReason> = new Set(['has_position', 'no_candle'])
// Rechazos de la orden de entrada por el exchange, con el motivo con que se informan.
const REJECTED_AS: Record<OrderRejectReason, BlockReason> = {
  min_notional: 'below_min_notional',
  insufficient_margin: 'insufficient_capital',
  opening_disabled: 'opening_disabled',
  foreign_position: 'foreign_position',
  exchange_rejected: 'exchange_rejected',
}

const WAIT: DecisionAction = { kind: 'wait' }

export async function runEntries(pass: EntryPass): Promise<Map<string, EntryOutcome>> {
  const outcomes = new Map<string, EntryOutcome>()
  for (const candidate of byConfidence(pass.candidates)) outcomes.set(candidate.view.symbol, await decide(pass, candidate))
  return outcomes
}

// Long si S′ ≥ θ, short si S′ ≤ −θ (spec §5.4).
export function entrySide(Sprime: number, theta: number): Side | null {
  if (Sprime >= theta) return 'long'
  if (Sprime <= -theta) return 'short'
  return null
}

// Se entra primero en las de mayor confianza (la del tamaño, a la mitad con un marco
// mayor en contra); los empates se ordenan por |S′| y por símbolo, para que el orden
// sea siempre el mismo.
function byConfidence(candidates: readonly Scored[]): Scored[] {
  return [...candidates].sort(
    (a, b) =>
      sizingConfidence(b.composite) - sizingConfidence(a.composite) ||
      Math.abs(b.composite.Sprime) - Math.abs(a.composite.Sprime) ||
      (a.view.symbol < b.view.symbol ? -1 : a.view.symbol > b.view.symbol ? 1 : 0),
  )
}

async function decide(pass: EntryPass, { view, composite }: Scored): Promise<EntryOutcome> {
  const { portfolio, settings, now } = pass
  const symbol = view.symbol
  const side = entrySide(composite.Sprime, settings.entry.theta)
  // En pausa el bot no evalúa entradas (spec §7): todas quedan `paused`.
  if (pass.paused) return quiet(blocked('paused', side))
  // Sin la vela de este ciclo S′ es viejo: la decisión es "sin vela" aunque no pase θ.
  if (pass.missing.has(symbol)) return quiet(blocked('no_candle', side))
  // Bajo el umbral la moneda espera; los cortes y los filtros sólo se miran cuando |S′| ≥ θ.
  if (side === null) return quiet(WAIT)
  if (pass.gate !== null) return quiet(blocked(pass.gate, side))

  const filter = entryFilters(view, composite, {
    hasPosition: portfolio.positions.has(symbol),
    inCooldown: portfolio.guard.inCooldown(symbol, now),
    inPenalty: portfolio.inPenalty(symbol, now),
    degraded: pass.degraded.has(symbol),
    direction: settings.mode === 'custom' ? settings.custom.direction : 'both',
    minRelVolume: settings.entry.minRelVolume,
  })
  if (filter !== null) return { action: blocked(filter, side), journal: !QUIET_FILTERS.has(filter) }

  const open = portfolio.positions.list()
  const account = portfolio.account.snapshot(open, pass.marks)
  const planned = plan(pass, view, composite, side, account.capitalBase, account.capitalOperable)
  if (!planned.ok) return noted(blocked(planned.reason, side))
  const capacity = checkCapacity({ open, side, plan: planned.plan, capitalBase: account.capitalBase, capitalOperable: account.capitalOperable, settings, mode: settings.mode })
  if (capacity !== null) return noted(blocked(capacity, side))
  // El tope de pérdida es de lo real, como `lossFloorPass`: la sombra no lo mira.
  if (portfolio.kind === 'real') {
    const floor = checkLossFloor({ capitalInicial: account.capitalInicial, saldo: account.saldo, open, plan: planned.plan, settings, realMoney: portfolio.realMoney })
    if (floor !== null) return noted(blocked(floor, side))
  }

  const outcome = await portfolio.positions.open({ symbol, plan: planned.plan, composite, tickSize: view.info.tickSize, mode: settings.mode })
  switch (outcome.kind) {
    case 'opened':
      pass.onOpened(outcome.opening)
      return quiet({ kind: 'enter', plan: planned.plan })
    case 'rejected':
      return noted(blocked(REJECTED_AS[outcome.reason], side))
    case 'failed':
      // Para la decisión es una moneda con datos que no sirven; la falla la registra el runtime.
      pass.onFailed(symbol, outcome.error)
      return quiet(blocked('degraded', side))
  }
}

function plan(pass: EntryPass, view: MarketView, composite: Composite, side: Side, capitalBase: number, capitalOperable: number): PlanResult {
  const { settings } = pass
  const common = { side, price: view.lastPrice, info: view.info, capitalBase, capitalOperable, settings, theta: settings.entry.theta }
  if (settings.mode === 'custom') return planCustomEntry(common)
  return planEntry({
    ...common,
    atr1h: atr(view.candles['1h'], ATR_PERIOD).at(-1) ?? Number.NaN,
    multipliers: {
      confidence: CONFIDENCE_FLOOR + CONFIDENCE_SLOPE * sizingConfidence(composite),
      symbol: pass.portfolio.symbolMultiplier(view.symbol, pass.now),
      btc: btcVolatilityMultiplier(view.btc),
    },
  })
}

function blocked(reason: BlockReason, wantedSide: Side | null): DecisionAction {
  return { kind: 'blocked', reason, wantedSide }
}

function quiet(action: DecisionAction): EntryOutcome {
  return { action, journal: false }
}

function noted(action: DecisionAction): EntryOutcome {
  return { action, journal: true }
}
