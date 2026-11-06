import { OrderRejectedError, type OrderRejectReason } from '../exchange/errors'
import { closingSide, direction } from '../exchange/sides'
import type { EngineExchange, FundingApplied, OrderId, TriggeredOrder } from '../exchange/types'
import { phraseLiquidationRecalculated, phraseOpen } from '../journal/phrases'
import type { CloseReason, ClosedPosition, Composite, EntryPlan, Fill, Position } from '../types'
import { stopCloseReason } from './exits'
import type { LiquidationRecalculated, OpenPositionState, ProtectiveOrder } from './types'

// Las abiertas de una cartera y su vida en el exchange: abrir con stop y take profit,
// mover el stop, cobrar funding y cerrar. Cada peso que el exchange mueve en la
// billetera pasa por `realize`, así la cuenta y la billetera no se separan nunca.

export interface Opening {
  position: Position
  fill: Fill
}

export interface Closing {
  closed: ClosedPosition
  fill: Fill
}

// Qué pasó al pedir una entrada. Lo que falla antes de la orden a mercado no deja nada
// en el exchange; un error después del fill dejaría una posición sin registrar y por
// eso no se ataja: se propaga.
export type OpenOutcome =
  | { kind: 'opened'; opening: Opening }
  // El exchange rechazó la orden por una regla suya (nocional mínimo al precio del fill, saldo).
  | { kind: 'rejected'; reason: OrderRejectReason }
  // Falló antes de la orden (un contrato que el simulador no conoce, sin precio, un bug).
  | { kind: 'failed'; error: unknown }

export interface OpenRequest {
  symbol: string
  plan: EntryPlan
  composite: Composite
  tickSize: number
  mode: Position['mode']
}

export interface PositionManagerDeps {
  exchange: EngineExchange
  shadow: boolean
  idPrefix: string
  // Resultado realizado (comisiones, pnl de cierres, funding) en el instante `at`.
  realize: (amount: number, at: number) => void
  // El exchange rechazó un stop, un take profit o la cancelación de un stop viejo; se
  // llama al empezar cada racha de rechazos.
  onProtectFailed: (symbol: string, order: ProtectiveOrder, error: unknown) => void
}

interface Outcome {
  fill: Fill
  reason: CloseReason
  pnlGross: number
  // Lo que el cierre movió en la billetera: bruto − comisión de salida, recortado si el saldo no alcanzó.
  realized: number
}

export class PositionManager {
  private readonly records = new Map<string, OpenPositionState>()
  // Órdenes (`símbolo:orden`) cuyo último intento el exchange rechazó.
  private readonly rejected = new Set<string>()
  // Con órdenes superpuestas: los stops viejos que siguen vivos en el exchange hasta que
  // el nuevo quede puesto (y entonces se cancelan), del más viejo al más nuevo. Si una
  // cancelación falla el id queda para reintentar y el trailing sigue: puede haber más
  // de uno pendiente.
  private readonly staleStops = new Map<string, OrderId[]>()

  constructor(private readonly deps: PositionManagerDeps) {}

  // Copias en orden de apertura: nadie de afuera muta una abierta.
  list(): Position[] {
    return [...this.records.values()].map((r) => ({ ...r.position }))
  }

  get(symbol: string): Position | undefined {
    const record = this.records.get(symbol)
    return record && { ...record.position }
  }

  has(symbol: string): boolean {
    return this.records.has(symbol)
  }

  tickSize(symbol: string): number {
    return this.require(symbol).tickSize
  }

  snapshot(): OpenPositionState[] {
    return structuredClone([...this.records.values()])
  }

  // Reconstruye abiertas persistidas sobre un exchange recién creado. Sus órdenes eran
  // de otro proceso: quedan sin id y `protect` las vuelve a colocar. Si el exchange
  // recalculó la liquidación (mmr nuevo), el registro toma la suya: los dos tienen que
  // liquidar en el mismo precio.
  restore(states: readonly OpenPositionState[]): LiquidationRecalculated[] {
    const recalculated: LiquidationRecalculated[] = []
    for (const state of states) {
      const p = state.position
      if (this.records.has(p.symbol)) throw new Error(`ya hay una posición en ${p.symbol}`)
      const { liquidationRecalculated } = this.deps.exchange.restorePosition({
        symbol: p.symbol,
        side: p.side,
        leverage: p.leverage,
        margin: p.margin,
        notional: p.notional,
        qty: p.qty,
        entryPrice: p.entryPrice,
        openedAt: p.openedAt,
        liquidationPrice: p.liquidationPrice,
        feesPaid: p.feesPaid,
        fundingPaid: p.fundingPaid,
      })
      const copy = structuredClone(state)
      const liquidationPrice = liquidationRecalculated?.to ?? p.liquidationPrice
      this.records.set(p.symbol, { ...copy, position: { ...copy.position, liquidationPrice, stopOrderId: null, tpOrderId: null } })
      if (liquidationRecalculated) {
        const { from, to } = liquidationRecalculated
        recalculated.push({ positionId: p.id, symbol: p.symbol, shadow: p.shadow, from, to, phrase: phraseLiquidationRecalculated(p, from, to) })
      }
    }
    return recalculated
  }

  // Orden a mercado y después stop y take profit.
  async open(request: OpenRequest): Promise<OpenOutcome> {
    const { symbol, plan, composite } = request
    const { exchange } = this.deps
    let fill: Fill
    try {
      await exchange.setLeverage(symbol, plan.leverage)
      fill = await exchange.placeMarketOrder({ symbol, side: plan.side === 'long' ? 'buy' : 'sell', qty: plan.qty })
    } catch (error) {
      return error instanceof OrderRejectedError ? { kind: 'rejected', reason: error.reason } : { kind: 'failed', error }
    }
    this.deps.realize(-fill.fee, fill.at)
    const state = (await exchange.getPositions()).find((p) => p.symbol === symbol)
    if (!state) throw new Error(`el exchange no informa la posición recién abierta en ${symbol}`)

    // Stop y take profit son los del plan, ya en la grilla del tick. La distancia y el
    // riesgo real se recalculan con el precio de entrada real (spread y slippage incluidos).
    const adverse = Math.abs(state.entryPrice - plan.stopPrice)
    const position: Position = {
      id: `${this.deps.idPrefix}-${this.deps.shadow ? 'shadow' : 'real'}-${symbol}-${state.openedAt}`,
      symbol,
      side: state.side,
      leverage: state.leverage,
      margin: state.margin,
      notional: state.notional,
      qty: state.qty,
      entryPrice: state.entryPrice,
      openedAt: state.openedAt,
      stopPrice: plan.stopPrice,
      takeProfitPrice: plan.takeProfitPrice,
      liquidationPrice: state.liquidationPrice,
      distanciaStop: adverse / state.entryPrice,
      riesgoReal: state.qty * adverse,
      thetaAtOpen: plan.theta,
      trailingActive: false,
      bestPrice: state.entryPrice,
      stopOrderId: null,
      tpOrderId: null,
      feesPaid: state.feesPaid,
      fundingPaid: state.fundingPaid,
      shadow: this.deps.shadow,
      openReason: '',
      signalsAtOpen: composite.signals,
      mode: request.mode,
    }
    position.openReason = phraseOpen(position, composite)
    this.records.set(symbol, { position, entryCosts: { spread: fill.spreadCost, slippage: fill.slippageCost }, tickSize: request.tickSize })
    await this.protect(symbol)
    return { kind: 'opened', opening: { position: { ...position }, fill } }
  }

  // Coloca el stop y el take profit que falten, por la cantidad de la posición y sólo
  // para reducirla. Una orden rechazada no deja la posición sin cuidar: el motor vigila
  // stop y take profit con cada tick y reintenta en el siguiente. Con el stop nuevo
  // puesto, se cancelan los viejos que lo cubrían; si el exchange no los cancela, se
  // reintenta igual que una orden rechazada, sin frenar el take profit.
  async protect(symbol: string): Promise<void> {
    const p = this.require(symbol).position
    const closing = { symbol, side: closingSide(p.side), qty: p.qty, reduceOnly: true } as const
    const { exchange } = this.deps
    if (p.stopOrderId === null) {
      p.stopOrderId = await this.place(symbol, 'stop', () => exchange.placeStopMarket({ ...closing, stopPrice: p.stopPrice }))
    }
    if (p.stopOrderId !== null) await this.cancelStaleStops(symbol)
    const target = p.takeProfitPrice
    if (target !== null && p.tpOrderId === null) {
      p.tpOrderId = await this.place(symbol, 'take_profit', () => exchange.placeTakeProfitMarket({ ...closing, stopPrice: target }))
    }
  }

  // Con una orden por símbolo, tipo y lado (el simulador, o Binance con closePosition:
  // error −4130) mover el stop es cancelar el viejo y colocar el nuevo. Con órdenes
  // superpuestas el viejo queda vivo hasta que el nuevo esté puesto: si el nuevo falla,
  // la posición sigue cubierta por el viejo y `protect` reintenta al precio nuevo.
  async moveStop(symbol: string, to: number): Promise<{ position: Position; from: number }> {
    const p = this.require(symbol).position
    const from = p.stopPrice
    if (p.stopOrderId !== null) {
      if (this.deps.exchange.protectiveOrders === 'overlapping') {
        this.staleStops.set(symbol, [...(this.staleStops.get(symbol) ?? []), p.stopOrderId])
      } else {
        await this.deps.exchange.cancelOrder(symbol, p.stopOrderId)
      }
      p.stopOrderId = null
    }
    p.stopPrice = to
    p.trailingActive = true
    await this.protect(symbol)
    return { position: { ...p }, from }
  }

  // Mejor precio de marca alcanzado: la referencia del trailing.
  observe(symbol: string, mark: number): void {
    const record = this.records.get(symbol)
    if (!record) return
    const p = record.position
    p.bestPrice = p.side === 'long' ? Math.max(p.bestPrice, mark) : Math.min(p.bestPrice, mark)
  }

  // Cierre a mercado. Cerrar la posición en el exchange cancela sus órdenes condicionales.
  // Lo realizado es lo que movió la billetera, no bruto − comisión: si el saldo no
  // alcanzaba para la pérdida, el exchange la recorta y la cuenta tiene que verlo igual.
  // Si el exchange no puede cerrar (sin precio), tira antes de tocar nada.
  async close(symbol: string, reason: CloseReason): Promise<Closing> {
    const record = this.require(symbol)
    const { exchange } = this.deps
    const before = await exchange.getBalance()
    const fill = await exchange.closePosition(symbol, reason)
    const after = await exchange.getBalance()
    const pnlGross = direction(record.position.side) * (fill.price - record.position.entryPrice) * fill.qty
    const realized = after.total - before.total
    this.deps.realize(realized, fill.at)
    return this.finish(record, { fill, reason, pnlGross, realized })
  }

  // Cierre que resolvió el exchange (stop, take profit, liquidación o, en uno real, una
  // posición cerrada allá o sin stop posible). Lo realizado es lo que de verdad movió la
  // billetera. Un stop se informa como stop o trailing según dónde estaba.
  settle(trigger: TriggeredOrder): Closing {
    const record = this.require(trigger.symbol)
    const reason = trigger.reason === 'stop' ? stopCloseReason(record.position) : trigger.reason
    this.deps.realize(trigger.realized, trigger.fill.at)
    return this.finish(record, { fill: trigger.fill, reason, pnlGross: trigger.pnlGross, realized: trigger.realized })
  }

  // Funding cobrado (positivo) o pagado (negativo); `fundingPaid` > 0 es lo pagado.
  fund(applied: FundingApplied): Position {
    const p = this.require(applied.symbol).position
    p.fundingPaid -= applied.amount
    this.deps.realize(applied.amount, applied.at)
    return { ...p }
  }

  private finish(record: OpenPositionState, outcome: Outcome): Closing {
    const { symbol } = record.position
    this.records.delete(symbol)
    this.rejected.delete(rejectionKey(symbol, 'stop'))
    this.rejected.delete(rejectionKey(symbol, 'take_profit'))
    this.rejected.delete(rejectionKey(symbol, 'stale_stop'))
    // Cerrar la posición en el exchange cancela sus órdenes, los stops viejos incluidos.
    this.staleStops.delete(symbol)
    return { closed: closedPosition(record, outcome), fill: outcome.fill }
  }

  // No tira: `protect` corre con cada tick y un viejo que el exchange no cancela (por
  // ejemplo, uno que ya no existe allá) no puede frenar el take profit, el trailing ni
  // el resto del ciclo. La racha termina cuando no queda ninguno pendiente.
  private async cancelStaleStops(symbol: string): Promise<void> {
    const stale = this.staleStops.get(symbol)
    if (stale === undefined) return
    const pending: OrderId[] = []
    for (const id of stale) {
      try {
        await this.deps.exchange.cancelOrder(symbol, id)
      } catch (error) {
        pending.push(id)
        this.noteRejected(symbol, 'stale_stop', error)
      }
    }
    if (pending.length > 0) {
      this.staleStops.set(symbol, pending)
      return
    }
    this.staleStops.delete(symbol)
    this.rejected.delete(rejectionKey(symbol, 'stale_stop'))
  }

  private async place(symbol: string, order: ProtectiveOrder, send: () => Promise<OrderId>): Promise<OrderId | null> {
    try {
      const id = await send()
      this.rejected.delete(rejectionKey(symbol, order))
      return id
    } catch (error) {
      this.noteRejected(symbol, order, error)
      return null
    }
  }

  // Un rechazo se avisa al empezar la racha: el reintento de cada tick no lo repite.
  private noteRejected(symbol: string, order: ProtectiveOrder, error: unknown): void {
    const key = rejectionKey(symbol, order)
    if (this.rejected.has(key)) return
    this.rejected.add(key)
    this.deps.onProtectFailed(symbol, order, error)
  }

  private require(symbol: string): OpenPositionState {
    const record = this.records.get(symbol)
    if (!record) throw new Error(`sin posición abierta en ${symbol}`)
    return record
  }
}

// pnl neto = lo que la posición movió en la billetera: lo realizado al cerrar − comisión
// de entrada − funding pagado, o sea bruto − comisiones − funding (spec §5.5 y §6). Si el
// saldo no alcanzó para la pérdida, el trade registra lo que de verdad se perdió, igual
// que la cuenta, y la diferencia con bruto − costos es el faltante. R = neto / riesgo real.
export function closedPosition(record: OpenPositionState, outcome: Outcome): ClosedPosition {
  const p = record.position
  const { fill } = outcome
  const fees = p.feesPaid + fill.fee
  const pnlNet = outcome.realized - p.feesPaid - p.fundingPaid
  return {
    ...p,
    feesPaid: fees,
    closedAt: fill.at,
    exitPrice: fill.price,
    closeReason: outcome.reason,
    pnlGross: outcome.pnlGross,
    pnlNet,
    rMultiple: p.riesgoReal > 0 ? pnlNet / p.riesgoReal : 0,
    costs: {
      fees,
      spread: record.entryCosts.spread + fill.spreadCost,
      slippage: record.entryCosts.slippage + fill.slippageCost,
      funding: p.fundingPaid,
    },
  }
}

function rejectionKey(symbol: string, order: ProtectiveOrder): string {
  return `${symbol}:${order}`
}
