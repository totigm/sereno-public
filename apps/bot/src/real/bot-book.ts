// Lo que el adaptador real sabe de lo suyo: las posiciones del bot (su cantidad, nunca la de
// Binance si Toti sumó a mano), la billetera de la sesión, los últimos precios y las colas de
// lo que Binance resolvió y el motor todavía no vio (cierres y funding).
//
// La billetera de la sesión es su saldo inicial más lo realizado menos las comisiones más el
// funding, todo según Binance. Un cierre encolado no la toca hasta que el motor lo recibe:
// así lo que el motor mide alrededor de `closePosition` (saldo antes y después) es el cierre.

import type { Balance, ExchangePosition, FundingApplied, PositionState, Prices } from '@sereno/core/src/exchange/types'
import { direction } from '@sereno/core/src/exchange/sides'
import type { Clock } from '../live/timers'
import type { PendingClose } from './pending-close'

type CloseWaiter = (close: PendingClose) => void

export class BotBook {
  private readonly positions = new Map<string, PositionState>()
  private readonly marks = new Map<string, Prices>()
  private readonly closes = new Map<string, PendingClose>()
  private readonly closeWaiters = new Map<string, CloseWaiter>()
  private funding: FundingApplied[] = []
  private wallet: number

  constructor(initialBalance: number) {
    if (!Number.isFinite(initialBalance) || initialBalance < 0) throw new RangeError(`saldo inicial inválido: ${initialBalance}`)
    this.wallet = initialBalance
  }

  // ---------- Precios ----------

  setPrices(symbol: string, prices: Prices): void {
    if (!isPositive(prices.mark) || !isPositive(prices.last)) throw new RangeError(`precio inválido en ${symbol}: marca ${prices.mark}, último ${prices.last}`)
    this.marks.set(symbol, { mark: prices.mark, last: prices.last })
  }

  pricesOf(symbol: string): Prices {
    const prices = this.marks.get(symbol)
    if (!prices) throw new Error(`sin precios para ${symbol}: setPrices o processTick van antes de operar`)
    return prices
  }

  // ---------- Posiciones y billetera ----------

  has(symbol: string): boolean {
    return this.positions.has(symbol)
  }

  get(symbol: string): PositionState | undefined {
    const p = this.positions.get(symbol)
    return p && { ...p }
  }

  require(symbol: string): PositionState {
    const p = this.get(symbol)
    if (!p) throw new Error(`el bot no tiene posición en ${symbol}`)
    return p
  }

  add(state: PositionState): void {
    if (this.positions.has(state.symbol)) throw new Error(`ya hay una posición del bot en ${state.symbol}`)
    this.positions.set(state.symbol, { ...state })
  }

  // El registro del motor para una posición que ya tiene (el motor se rehízo): lo encolado sigue.
  replace(state: PositionState): void {
    if (!this.positions.has(state.symbol)) throw new Error(`el bot no tiene posición en ${state.symbol}`)
    this.positions.set(state.symbol, { ...state })
  }

  // La posición deja de ser del bot y lo que realizó entra a la billetera. Un cierre encolado
  // que quedara (la reconciliación vio por REST el mismo cierre que hizo el bot) sobra.
  settle(symbol: string, realized: number): ExchangePosition {
    const view = this.view(this.require(symbol))
    this.positions.delete(symbol)
    this.closes.delete(symbol)
    this.wallet += realized
    return view
  }

  realize(amount: number): void {
    this.wallet += amount
  }

  views(): ExchangePosition[] {
    return [...this.positions.values()].map((p) => this.view(p))
  }

  view(state: PositionState): ExchangePosition {
    const markPrice = this.marks.get(state.symbol)?.mark ?? state.entryPrice
    return { ...state, markPrice, unrealized: direction(state.side) * (markPrice - state.entryPrice) * state.qty }
  }

  // En margen aislado el no realizado no suma ni resta disponible: sólo el margen ocupado.
  balance(): Balance {
    const views = this.views()
    const marginInUse = views.reduce((sum, p) => sum + p.margin, 0)
    return { total: this.wallet, available: Math.max(0, this.wallet - marginInUse), marginInUse, unrealized: views.reduce((sum, p) => sum + p.unrealized, 0) }
  }

  // ---------- Cierres que resolvió Binance ----------

  // Un cierre por posición: el primero que llega manda (el stream y la reconciliación pueden
  // ver el mismo). Si alguien lo está esperando (`closePosition` con el stop recién
  // disparado) se le entrega a él y no queda en la cola. false si no se tomó.
  queueClose(symbol: string, close: PendingClose): boolean {
    if (this.closes.has(symbol)) return false
    const waiter = this.closeWaiters.get(symbol)
    if (waiter) {
      this.closeWaiters.delete(symbol)
      waiter(close)
      return true
    }
    this.closes.set(symbol, close)
    return true
  }

  hasClose(symbol: string): boolean {
    return this.closes.has(symbol)
  }

  takeClose(symbol: string): PendingClose | undefined {
    const close = this.closes.get(symbol)
    this.closes.delete(symbol)
    return close
  }

  // El cierre que llegue para `symbol` dentro de `ms`; null si no llega.
  waitClose(symbol: string, ms: number, clock: Clock): Promise<PendingClose | null> {
    const queued = this.takeClose(symbol)
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => {
      const timer = clock.timers.setTimeout(() => {
        this.closeWaiters.delete(symbol)
        resolve(null)
      }, ms)
      this.closeWaiters.set(symbol, (close) => {
        clock.timers.clearTimeout(timer)
        resolve(close)
      })
    })
  }

  // ---------- Funding que informó Binance ----------

  queueFunding(applied: FundingApplied): void {
    this.funding.push({ ...applied })
  }

  takeFunding(symbol: string): FundingApplied[] {
    const taken = this.funding.filter((f) => f.symbol === symbol)
    this.funding = this.funding.filter((f) => f.symbol !== symbol)
    return taken
  }

  // Lo cobrado (positivo) o pagado entra a la billetera y a la posición.
  fund(applied: FundingApplied): void {
    const p = this.positions.get(applied.symbol)
    if (!p) throw new Error(`el bot no tiene posición en ${applied.symbol} para el funding`)
    p.fundingPaid -= applied.amount
    this.wallet += applied.amount
  }
}

function isPositive(x: number): boolean {
  return Number.isFinite(x) && x > 0
}
