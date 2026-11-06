import type { Settings } from '@sereno/shared'
import type { ReleaseResult } from '../capital/account'
import { initialLearningState } from '../learning/state'
import { computeComposite } from '../signals/composite'
import type { ClosedPosition, CloseReason, Decision, EngineEvent, FundingEvent, LearningState, MarketView, MarkTick, Position } from '../types'
import { initialGuardState } from './account-guard'
import { Desk, type ExitCycle } from './desk'
import { runEntries, type EntryOutcome, type Scored } from './entries'
import { decisionsMade, fundingApplied, learningUpdated, positionOpened, waited } from './events'
import { LearnedPortfolio, ShadowPortfolio } from './portfolio'
import type { CycleContext, CycleResult, EngineDeps, EngineFailure, EngineSnapshot, EngineState, PortfolioKind, ProtectiveOrder, RestoreReport, Scorer } from './types'

// Motor de trading (spec §5 y §6). Cada vela de 15m: (1) salidas por señal y por tiempo,
// (2) blindaje, tope de pérdida y reglas de cuenta, (3) entradas por confianza y (4)
// eventos. Cada tick de marca: órdenes disparadas, trailing, respaldo de stop y take
// profit, blindaje y tope de pérdida.
// La cartera aprendida y la sombra corren las mismas reglas, cada una en su exchange.
//
// El exchange es asincrónico: las operaciones públicas se encolan y corren de a una, así
// un tick nunca ve una apertura a medio hacer. Lo que falla con una moneda (o un dato
// inválido del stream) se saltea y se avisa por `onFailure`: el resto del ciclo sigue.

// Como máximo un "esperé" por moneda cada 4 horas (spec §9).
const WAIT_JOURNAL_MS = 4 * 3_600_000

interface Cycle extends ExitCycle {
  views: readonly MarketView[]
  // Las vistas con precios válidos: sólo esas mueven el mercado de los exchanges.
  priced: readonly MarketView[]
  degraded: ReadonlySet<string>
}

interface PortfolioRun {
  scored: Map<string, Scored>
  outcomes: Map<string, EntryOutcome>
  opened: Position[]
  closed: ClosedPosition[]
}

export class TradingEngine {
  private settings: Settings
  private readonly real: LearnedPortfolio
  private readonly shadow: ShadowPortfolio | null
  private readonly realDesk: Desk
  private readonly desks: readonly Desk[]
  private readonly scorer: Scorer
  private readonly clock: () => number
  private readonly sink: (e: EngineEvent) => void
  private readonly onFailure: (failure: EngineFailure) => void
  // Última marca conocida por símbolo (vistas y ticks): la de las salidas y la cuenta.
  private readonly marks = new Map<string, number>()
  private waitedAt: Record<string, number> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private fresh = true

  constructor(deps: EngineDeps) {
    const { idPrefix } = deps
    if (idPrefix.length === 0) throw new RangeError('idPrefix vacío: cada sesión necesita sus propios ids de posición')
    const now = deps.clock()
    this.settings = deps.settings
    this.scorer = deps.scorer ?? computeComposite
    this.clock = deps.clock
    this.sink = deps.sink
    this.onFailure = deps.onFailure
    const onProtectFailed =
      (portfolio: PortfolioKind) =>
      (symbol: string, order: ProtectiveOrder, error: unknown): void =>
        this.onFailure({ operation: 'protect', portfolio, order, symbol, at: this.clock(), error })
    this.real = new LearnedPortfolio(
      { exchange: deps.exchange, account: deps.account, guard: initialGuardState(now), idPrefix, onProtectFailed: onProtectFailed('real'), realMoney: deps.realMoney === true },
      deps.learning,
    )
    this.shadow = deps.shadow
      ? new ShadowPortfolio({ ...deps.shadow, guard: initialGuardState(now), idPrefix, onProtectFailed: onProtectFailed('shadow') }, initialLearningState(now))
      : null
    const desk = (portfolio: LearnedPortfolio | ShadowPortfolio) =>
      new Desk({ portfolio, session: () => this.settings, marks: this.marks, emit: (e) => this.sink(e), fail: (f) => this.onFailure(f) })
    this.realDesk = desk(this.real)
    this.desks = this.shadow ? [this.realDesk, desk(this.shadow)] : [this.realDesk]
  }

  onCandleClose(views: MarketView[], ctx: CycleContext): Promise<CycleResult> {
    return this.serial(() => this.cycle(views, ctx))
  }

  onMarkTick(tick: MarkTick): Promise<void> {
    return this.serial(() => this.markTick(tick))
  }

  // false si la liquidación es inválida y no se cobró (también se avisa por `onFailure`):
  // quien la trajo decide si la reintenta.
  onFunding(ev: FundingEvent): Promise<boolean> {
    return this.serial(async () => {
      if (!Number.isFinite(ev.rate) || !isPrice(ev.markPrice)) {
        this.onFailure({ operation: 'funding', symbol: ev.symbol, at: ev.at, error: new RangeError(`funding inválido en ${ev.symbol}: tasa ${ev.rate}, marca ${ev.markPrice}`) })
        return false
      }
      this.fresh = false
      for (const { portfolio } of this.desks) {
        for (const applied of portfolio.exchange.applyFunding(ev)) {
          const position = portfolio.positions.fund(applied)
          this.sink(fundingApplied(position.id, applied.amount, applied.at))
        }
      }
      return true
    })
  }

  // Cierre pedido (Toti, el runtime) de una posición real. null si no hay abierta; si el
  // exchange no puede cerrarla, rechaza (el comando queda con error).
  closePosition(symbol: string, reason: CloseReason): Promise<ClosedPosition | null> {
    return this.serial(async () => {
      this.fresh = false
      if (!this.real.positions.has(symbol)) return null
      const closed = await this.realDesk.closeAtMarket(symbol, reason)
      this.realDesk.evaluateRules(this.clock())
      return closed
    })
  }

  // Cierra todas las reales: las que el exchange no puede cerrar siguen abiertas y se
  // avisan por `onFailure`. La sombra no se toca: es la comparación de la estrategia,
  // no plata de Toti.
  closeAll(reason: CloseReason): Promise<ClosedPosition[]> {
    return this.serial(async () => {
      this.fresh = false
      const now = this.clock()
      const closed: ClosedPosition[] = []
      for (const p of this.real.positions.list()) await this.realDesk.tryClose(p.symbol, reason, now, closed)
      if (closed.length > 0) this.realDesk.evaluateRules(now)
      return closed
    })
  }

  // La sombra copia el modo, el riesgo y el capital de la sesión (sólo cambia con qué decide).
  // Pasar de pausado a reanudado es "Toti reanudó": lo real deja la pausa por drawdown
  // (la sombra nunca entra en ella, ver `DrawdownBehavior`).
  applySettings(settings: Settings): Promise<void> {
    return this.serial(async () => {
      const resumed = this.settings.pause.paused && !settings.pause.paused
      this.settings = settings
      for (const { portfolio } of this.desks) {
        portfolio.account.setReinvest(settings.capital.reinvest)
        portfolio.account.setProtectPct(settings.capital.protectPct)
        portfolio.account.setOnShield(settings.capital.onShield)
      }
      if (resumed) this.real.guard.resume()
    })
  }

  // Estado de aprendizaje nuevo (ajuste semanal, confiabilidad, edición): sólo lo aprendido.
  applyLearning(learning: LearningState): Promise<void> {
    return this.serial(async () => {
      this.real.learning = structuredClone(learning)
    })
  }

  // "Volver a usar el capital blindado" (spec §7), pedido por Toti: sólo la cuenta real.
  // La sombra mide la estrategia por defecto con sus propias reglas de capital.
  releaseProtected(): Promise<ReleaseResult> {
    return this.serial(async () => {
      this.fresh = false
      return this.real.account.releaseProtected()
    })
  }

  // Retoma una sesión persistida. Sólo sobre un motor recién creado: mezclar abiertas de
  // dos procesos dejaría al exchange y a la cuenta contando cosas distintas.
  // Si el estado trae la pausa por drawdown y los ajustes ya no están pausados, Toti
  // reanudó mientras el bot estaba apagado: el motor nunca vio la transición de
  // `applySettings`, así que la pausa se levanta acá con la misma regla del pico.
  // Informa las abiertas cuya liquidación se recalculó con el mmr vigente (el runtime las
  // registra; la base toma la nueva al sincronizar las abiertas).
  restore(state: EngineState): Promise<RestoreReport> {
    return this.serial(async () => {
      if (!this.fresh) throw new Error('restore sólo vale sobre un motor recién creado')
      if (state.shadow !== null && this.shadow === null && state.shadow.positions.length > 0) {
        throw new Error('el estado trae abiertas de la sombra y el motor no tiene sombra')
      }
      this.fresh = false
      const liquidations = this.real.restore(state.real)
      if (!this.settings.pause.paused) this.real.guard.resume()
      if (state.shadow !== null && this.shadow !== null) {
        liquidations.push(...this.shadow.restore(state.shadow))
        this.shadow.learning = structuredClone(state.shadow.learning)
      }
      this.waitedAt = { ...state.waitedAt }
      return { liquidations }
    })
  }

  // Retoma después de un hueco sin precios (reinicio o reconexión, spec §12): cada tick
  // es el precio actual de su moneda. Las abiertas cuyo stop quedó atrás se cierran a ese
  // precio como "stop no ejecutado por bot sin conexión", en las dos carteras; el resto
  // sigue y sus órdenes se reponen con el próximo tick.
  reconcile(ticks: readonly MarkTick[]): Promise<ClosedPosition[]> {
    return this.serial(async () => {
      const closed: ClosedPosition[] = []
      for (const tick of ticks) {
        if (!this.validTick(tick)) continue
        this.fresh = false
        this.marks.set(tick.symbol, tick.markPrice)
        for (const desk of this.desks) {
          const own: ClosedPosition[] = []
          await desk.reconcile(tick, own)
          if (own.length > 0) desk.evaluateRules(tick.at)
          closed.push(...own)
        }
      }
      return closed
    })
  }

  snapshot(): EngineSnapshot {
    const marks = this.realDesk.markRecord()
    const shadow = this.shadow
    return {
      at: this.clock(),
      real: this.real.state(),
      shadow: shadow ? { ...shadow.state(), learning: structuredClone(shadow.learning) } : null,
      waitedAt: { ...this.waitedAt },
      learning: structuredClone(this.real.learning),
      accounts: {
        real: this.real.account.snapshot(this.real.positions.list(), marks),
        shadow: shadow ? shadow.account.snapshot(shadow.positions.list(), marks) : null,
      },
    }
  }

  private async cycle(views: readonly MarketView[], ctx: CycleContext): Promise<CycleResult> {
    this.fresh = false
    const now = this.clock()
    assertUniqueSymbols(views)
    const delisted = new Set(ctx.delisted ?? [])
    // Un contrato deslistado no se vuelve a abrir: para las entradas es una moneda degradada.
    const degraded = new Set([...ctx.degraded, ...delisted])
    const priced: MarketView[] = []
    for (const view of views) {
      if (isPrice(view.markPrice) && isPrice(view.lastPrice)) {
        priced.push(view)
        this.marks.set(view.symbol, view.markPrice)
      } else {
        degraded.add(view.symbol)
      }
    }
    const cycle: Cycle = { views, priced, now, missing: new Set(ctx.missingSymbols), degraded, delisted }

    for (const { portfolio } of this.desks) {
      const released = portfolio.releasePenalties(now)
      if (portfolio.kind === 'real') for (const change of released) this.sink(learningUpdated(change))
    }
    const runs: PortfolioRun[] = []
    for (const desk of this.desks) runs.push(await this.runPortfolio(desk, cycle))
    const [real, shadow] = runs
    if (!real) throw new Error('el ciclo no corrió la cartera real')

    this.journalWaits(views, real)
    const decisions = views.map((view) => decisionRow(view, real, shadow ?? null))
    this.sink(decisionsMade(views[0]?.t ?? now, decisions))
    return { decisions, opened: runs.flatMap((r) => r.opened), closed: runs.flatMap((r) => r.closed) }
  }

  private async runPortfolio(desk: Desk, cycle: Cycle): Promise<PortfolioRun> {
    const { portfolio } = desk
    const closed: ClosedPosition[] = []
    // El precio de la vista es la marca más reciente: puede haber cruzado un stop.
    for (const view of cycle.priced) await desk.followMarket(viewTick(view, cycle.now), closed)

    const scored = new Map<string, Scored>()
    for (const view of cycle.views) scored.set(view.symbol, { view, composite: this.scorer(view, portfolio.weights(view.symbol, this.settings)) })

    // (1) salidas, (2) blindaje, tope de pérdida y cortes de cuenta.
    await desk.exitPass(cycle, scored, closed)
    await desk.shieldPass(cycle.now, closed)
    await desk.lossFloorPass(cycle.now, closed)
    desk.shieldShortfall(cycle.views, cycle.now)
    const blocked = desk.evaluateRules(cycle.now)

    // (3) entradas: la pausa de la sesión primero, después el corte más grave.
    const opened: Position[] = []
    const outcomes = await runEntries({
      portfolio,
      settings: desk.settings(),
      candidates: [...scored.values()],
      paused: this.settings.pause.paused,
      gate: blocked,
      missing: cycle.missing,
      degraded: cycle.degraded,
      now: cycle.now,
      marks: desk.markRecord(),
      onOpened: ({ position, fill }) => {
        opened.push(position)
        this.sink(positionOpened(position, fill))
      },
      onFailed: (symbol, error) => this.onFailure({ operation: 'open', portfolio: portfolio.kind, symbol, at: cycle.now, error }),
    })
    return { scored, outcomes, opened, closed }
  }

  // Un tick inválido no se aplica (la última marca válida sigue mandando) ni rechaza: el
  // runtime lo llama desde el stream y un rechazo sin atajar tumbaría el proceso.
  private async markTick(tick: MarkTick): Promise<void> {
    if (!this.validTick(tick)) return
    this.fresh = false
    this.marks.set(tick.symbol, tick.markPrice)
    for (const desk of this.desks) {
      const closed: ClosedPosition[] = []
      await desk.followMarket(tick, closed)
      await desk.shieldPass(tick.at, closed)
      await desk.lossFloorPass(tick.at, closed)
      if (closed.length > 0) desk.evaluateRules(tick.at)
    }
  }

  private validTick(tick: MarkTick): boolean {
    if (isPrice(tick.markPrice) && isPrice(tick.lastPrice)) return true
    this.onFailure({ operation: 'tick', symbol: tick.symbol, at: tick.at, error: new RangeError(`tick inválido en ${tick.symbol}: marca ${tick.markPrice}, último ${tick.lastPrice}`) })
    return false
  }

  private journalWaits(views: readonly MarketView[], real: PortfolioRun): void {
    for (const view of views) {
      const outcome = real.outcomes.get(view.symbol)
      const composite = real.scored.get(view.symbol)?.composite
      if (!outcome?.journal || outcome.action.kind !== 'blocked' || !composite) continue
      const last = this.waitedAt[view.symbol]
      if (last !== undefined && view.t - last < WAIT_JOURNAL_MS) continue
      this.waitedAt[view.symbol] = view.t
      this.sink(waited(view.t, view.symbol, outcome.action.reason, composite, outcome.action.wantedSide))
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}

function decisionRow(view: MarketView, real: PortfolioRun, shadow: PortfolioRun | null): Decision {
  const decision: Decision = { t: view.t, symbol: view.symbol, composite: scoredOf(real, view.symbol).composite, action: outcomeOf(real, view.symbol).action }
  if (shadow) decision.shadow = { Sprime: scoredOf(shadow, view.symbol).composite.Sprime, action: outcomeOf(shadow, view.symbol).action.kind }
  return decision
}

function scoredOf(run: PortfolioRun, symbol: string): Scored {
  const scored = run.scored.get(symbol)
  if (!scored) throw new Error(`sin puntaje para ${symbol}`)
  return scored
}

function outcomeOf(run: PortfolioRun, symbol: string): EntryOutcome {
  const outcome = run.outcomes.get(symbol)
  if (!outcome) throw new Error(`sin decisión para ${symbol}`)
  return outcome
}

// Las decisiones se cruzan por símbolo: dos vistas de la misma moneda serían ambiguas.
function assertUniqueSymbols(views: readonly MarketView[]): void {
  const seen = new Set<string>()
  for (const { symbol } of views) {
    if (seen.has(symbol)) throw new RangeError(`vista repetida para ${symbol}`)
    seen.add(symbol)
  }
}

function isPrice(x: number): boolean {
  return Number.isFinite(x) && x > 0
}

function viewTick(view: MarketView, at: number): MarkTick {
  return { symbol: view.symbol, markPrice: view.markPrice, lastPrice: view.lastPrice, at, fundingRate: null, nextFundingTime: null }
}
