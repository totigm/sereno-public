import type { Settings } from '@sereno/shared'
import type { Marks } from '../capital/account'
import { lossFloor } from '../risk/loss-floor'
import type { BlockReason, ClosedPosition, CloseReason, EngineEvent, MarketView, MarkTick, Position } from '../types'
import type { Scored } from './entries'
import { accountRuleTriggered, learningUpdated, positionClosed, shadowDrawdown, stopMoved } from './events'
import { crossedExit, exitRulesFor, nextStop, shouldSignalExit, shouldTimeExit, stopCloseReason, unrealizedR } from './exits'
import type { Portfolio } from './portfolio'
import type { Closing } from './position-manager'
import type { EngineFailure } from './types'

// La mesa de una cartera: lo que el motor hace sobre sus abiertas con cada precio y cada
// ciclo (salidas, trailing, blindaje, tope de pérdida, cortes de cuenta) y los eventos
// que eso produce.
// Todo cierre pasa por `finishClose`, así racha, enfriamiento, diario y aprendizaje
// nunca se saltean.

export interface DeskDeps {
  portfolio: Portfolio
  // Los ajustes de la sesión, tal como están ahora (la cartera deriva los suyos).
  session: () => Settings
  // Última marca conocida por símbolo, compartida por las dos carteras.
  marks: ReadonlyMap<string, number>
  emit: (event: EngineEvent) => void
  fail: (failure: EngineFailure) => void
}

export interface ExitCycle {
  now: number
  missing: ReadonlySet<string>
  delisted: ReadonlySet<string>
}

export class Desk {
  readonly portfolio: Portfolio

  constructor(private readonly deps: DeskDeps) {
    this.portfolio = deps.portfolio
  }

  settings(): Settings {
    return this.portfolio.settings(this.deps.session())
  }

  markRecord(): Marks {
    return Object.fromEntries(this.deps.marks)
  }

  // Las marcas, y el stop de cada abierta que todavía no tiene.
  private marksOrStops(): Marks {
    const marks = this.markRecord()
    for (const p of this.portfolio.positions.list()) marks[p.symbol] ??= p.stopPrice
    return marks
  }

  // Un precio nuevo: lo que disparó el exchange, el respaldo si la marca cruzó stop o
  // take profit sin disparo, el trailing y las órdenes que falten.
  async followMarket(tick: MarkTick, closed: ClosedPosition[]): Promise<void> {
    const { positions, exchange } = this.portfolio
    const { symbol } = tick
    if (!positions.has(symbol)) {
      exchange.setPrices(symbol, { mark: tick.markPrice, last: tick.lastPrice })
      return
    }
    for (const trigger of exchange.processTick(tick)) closed.push(this.finishClose(positions.settle(trigger)))
    const p = positions.get(symbol)
    if (!p) return

    const crossed = crossedExit(p, tick.markPrice)
    if (crossed !== null) {
      closed.push(await this.closeAtMarket(symbol, crossed === 'stop' ? stopCloseReason(p) : 'take_profit'))
      return
    }
    positions.observe(symbol, tick.markPrice)
    const observed = positions.get(symbol) ?? p
    const to = nextStop(observed, tick.markPrice, exitRulesFor(observed, this.settings(), positions.tickSize(symbol)))
    if (to === null) {
      await positions.protect(symbol)
      return
    }
    const moved = await positions.moveStop(symbol, to)
    this.deps.emit(stopMoved(moved.position, moved.from, to, tick.at))
  }

  // El precio actual después de un hueco: se fija sin pasar por `processTick` (una orden
  // que disparara cerraría como un stop normal, al precio de ahora) y si la marca ya pasó
  // el stop, el cierre es el del stop no ejecutado mientras el bot no tenía precios.
  async reconcile(tick: MarkTick, closed: ClosedPosition[]): Promise<void> {
    const { positions, exchange } = this.portfolio
    exchange.setPrices(tick.symbol, { mark: tick.markPrice, last: tick.lastPrice })
    const p = positions.get(tick.symbol)
    if (p && crossedExit(p, tick.markPrice) === 'stop') await this.tryClose(tick.symbol, 'stop_missed_offline', tick.at, closed)
  }

  // Salidas del ciclo: deslistadas, señal dada vuelta (no con un S′ viejo) y tiempo.
  async exitPass(cycle: ExitCycle, scored: ReadonlyMap<string, Scored>, closed: ClosedPosition[]): Promise<void> {
    const settings = this.settings()
    for (const p of this.portfolio.positions.list()) {
      const reason = this.cycleExit(p, cycle, scored, settings)
      if (reason !== null) await this.tryClose(p.symbol, reason, cycle.now, closed)
    }
  }

  // Al disparar, el blindaje cierra lo que no entra en lo ganado (`alBlindar`). Sin la
  // marca de alguna abierta no se evalúa (`skipped`): se reintenta con el próximo precio.
  async shieldPass(at: number, closed: ClosedPosition[]): Promise<void> {
    const { account, positions } = this.portfolio
    const check = account.checkShield(positions.list(), this.markRecord())
    if (!check.triggered) return
    let closedCount = 0
    for (const p of check.toClose) if (await this.tryClose(p.symbol, 'shield_reduce', at, closed)) closedCount += 1
    if (this.portfolio.kind !== 'real') return
    const snapshot = account.snapshot(positions.list(), this.markRecord())
    this.deps.emit(
      accountRuleTriggered(at, 'shield', {
        capitalInicial: snapshot.capitalInicial,
        baseBlindaje: snapshot.baseBlindaje,
        ganancia: snapshot.saldo - snapshot.baseBlindaje,
        closedCount,
      }),
    )
  }

  // Tope de pérdida en marcha, sólo de lo real: si la equity toca el piso se pone el
  // pestillo (la cartera no abre más), se cierra todo y se avisa una vez. Sin la marca de
  // alguna abierta, en papel no se evalúa (se reintenta con el próximo precio); con plata real
  // esa abierta cuenta a su stop, así una moneda sin precio no deja sin tope a las demás. Con
  // el pestillo ya puesto, lo que no se pudo cerrar se cierra en cuanto su moneda tiene precio.
  async lossFloorPass(at: number, closed: ClosedPosition[]): Promise<void> {
    if (this.portfolio.kind !== 'real') return
    const { account, positions, guard } = this.portfolio
    if (guard.lossFloorHit()) {
      for (const p of positions.list()) if (this.deps.marks.has(p.symbol)) await this.tryClose(p.symbol, 'loss_floor', at, closed)
      return
    }
    const floor = lossFloor(account.capitalInicial, this.settings().risk.lossCap, this.portfolio.realMoney)
    if (floor === null) return
    const snapshot = account.snapshot(positions.list(), this.portfolio.realMoney ? this.marksOrStops() : this.markRecord())
    if (snapshot.marksIncomplete || snapshot.equity > floor) return
    guard.noteLossFloor()
    let closedCount = 0
    for (const p of positions.list()) if (await this.tryClose(p.symbol, 'loss_floor', at, closed)) closedCount += 1
    this.deps.emit(accountRuleTriggered(at, 'loss_floor', { capitalInicial: snapshot.capitalInicial, floor, equity: snapshot.equity, closedCount }))
  }

  // Capital blindado, nada abierto y lo que queda no alcanza el margen mínimo de ninguna
  // moneda del universo: el bot no puede operar. Se avisa una vez y el runtime lo pausa.
  shieldShortfall(views: readonly MarketView[], now: number): void {
    if (this.portfolio.kind !== 'real' || views.length === 0) return
    const { account, positions, guard } = this.portfolio
    const settings = this.settings()
    const open = positions.list()
    const snapshot = account.snapshot(open, this.markRecord())
    const leverage = settings.mode === 'auto' ? settings.risk.maxLeverage : settings.custom.leverage
    const minMargin = Math.min(...views.map((v) => v.info.minNotional / leverage))
    const active = snapshot.protegido > 0 && open.length === 0 && snapshot.capitalOperable < minMargin
    if (guard.noteShieldShortfall(active)) this.deps.emit(accountRuleTriggered(now, 'shield_insufficient', { baseBlindaje: snapshot.baseBlindaje }))
  }

  // Cortes de cuenta con el estado de ahora. Los de lo real van al diario. La sombra
  // respeta los suyos en silencio, salvo el drawdown: ahí no se pausa como lo real y
  // queda registrado, marcado como de la sombra.
  evaluateRules(now: number): BlockReason | null {
    const { account, positions, guard } = this.portfolio
    const snapshot = account.snapshot(positions.list(), this.markRecord())
    const { blocked, triggers } = guard.evaluate({
      now,
      capitalBase: snapshot.capitalBase,
      equity: snapshot.marksIncomplete ? null : snapshot.equity,
      settings: this.settings(),
    })
    for (const trigger of triggers) {
      if (this.portfolio.kind === 'real') this.deps.emit(accountRuleTriggered(now, trigger.rule, trigger.data))
      else if (trigger.rule === 'drawdown') this.deps.emit(shadowDrawdown(now, trigger.data))
    }
    return blocked
  }

  // Cierre a mercado que tira si el exchange no puede cerrar (para quien lo pidió).
  async closeAtMarket(symbol: string, reason: CloseReason): Promise<ClosedPosition> {
    return this.finishClose(await this.portfolio.positions.close(symbol, reason))
  }

  // Cierre a mercado que no frena al resto: si el exchange no puede cerrar (una abierta
  // que todavía no tiene precio), no cambió nada; la posición sigue con sus órdenes, se
  // avisa la falla y se reintenta con el próximo ciclo. true si cerró.
  async tryClose(symbol: string, reason: CloseReason, at: number, closed: ClosedPosition[]): Promise<boolean> {
    let closing: Closing
    try {
      closing = await this.portfolio.positions.close(symbol, reason)
    } catch (error) {
      this.deps.fail({ operation: 'close', portfolio: this.portfolio.kind, symbol, reason, at, error })
      return false
    }
    closed.push(this.finishClose(closing))
    return true
  }

  private cycleExit(p: Position, cycle: ExitCycle, scored: ReadonlyMap<string, Scored>, settings: Settings): CloseReason | null {
    const { symbol } = p
    if (cycle.delisted.has(symbol)) return 'delisted'
    const rules = exitRulesFor(p, settings, this.portfolio.positions.tickSize(symbol))
    const composite = scored.get(symbol)?.composite
    if (composite && !cycle.missing.has(symbol) && shouldSignalExit(p, composite.Sprime, rules)) return 'signal_flip'
    const mark = this.deps.marks.get(symbol)
    if (mark !== undefined && shouldTimeExit(p, cycle.now, unrealizedR(p, mark), rules)) return 'time_exit'
    return null
  }

  // Racha y enfriamiento, el evento del cierre y después lo que aprendió de él.
  private finishClose({ closed, fill }: Closing): ClosedPosition {
    this.portfolio.guard.noteClose(closed, this.settings().entry)
    this.deps.emit(positionClosed(closed, fill))
    for (const change of this.portfolio.learn(closed, this.deps.session())) this.deps.emit(learningUpdated(change))
    return closed
  }
}
