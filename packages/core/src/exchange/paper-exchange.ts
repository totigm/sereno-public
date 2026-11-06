import type { RiskSettings } from '../risk/costs'
import { liquidationPrice } from '../risk/liquidation'
import { floorToStep } from '../risk/sizing'
import type { CloseReason, Fill, FundingEvent, MarkTick, SymbolInfo } from '../types'
import { OrderRejectedError } from './errors'
import { fillPrice, slippageForNotional } from './fills'
import { OrderBook } from './order-book'
import { assertQty, assertRestorable, isPositive, leavesDust, restoredLiquidation } from './position-checks'
import { closingSide, direction, positionSideOf } from './sides'
import { bankruptcyPrice, liquidationCrossed, orderTriggered, pastBankruptcy } from './triggers'
import type {
  Balance,
  EngineExchange,
  ExchangePosition,
  FundingApplied,
  MarketOrder,
  Order,
  OrderId,
  OrderSide,
  OrderType,
  PositionState,
  Prices,
  RestoreResult,
  SimulatedFill,
  StopOrder,
  TriggeredOrder,
  Unsubscribe,
} from './types'
import { Wallet } from './wallet'

export interface PaperExchangeOptions {
  settings: RiskSettings
  infos: Record<string, SymbolInfo>
  clock: () => number
  initialBalance: number
}

interface Settlement {
  pnlGross: number
  realized: number
  shortfall: number
}

// Simulador de Binance USDT-M (spec §6): one-way mode, margen aislado, una posición
// por símbolo, fills a mercado sobre el último precio y órdenes condicionales que
// disparan por precio de marca. Es puro: el tiempo entra por `clock` y por los ticks.
export class PaperExchange implements EngineExchange {
  private readonly risk: RiskSettings
  private readonly infos: Record<string, SymbolInfo>
  private readonly clock: () => number
  private readonly wallet: Wallet
  private readonly book = new OrderBook()
  private readonly prices = new Map<string, Prices>()
  private readonly leverages = new Map<string, number>()
  private readonly positions = new Map<string, PositionState>()
  private readonly markListeners = new Set<(tick: MarkTick) => void>()
  private readonly fundingListeners = new Set<(ev: FundingEvent) => void>()

  constructor(opts: PaperExchangeOptions) {
    this.risk = opts.settings
    this.infos = opts.infos
    this.clock = opts.clock
    this.wallet = new Wallet(opts.initialBalance)
  }

  setPrices(symbol: string, prices: Prices): void {
    if (!isPositive(prices.mark) || !isPositive(prices.last)) {
      throw new RangeError(`precio inválido en ${symbol}: marca ${prices.mark}, último ${prices.last}`)
    }
    this.prices.set(symbol, { mark: prices.mark, last: prices.last })
  }

  // Reconstruye una posición persistida al reiniciar el bot. No cobra comisión: el
  // saldo inicial que recibe el simulador ya la descontó.
  restorePosition(state: PositionState): RestoreResult {
    const info = this.infoOf(state.symbol)
    if (this.positions.has(state.symbol)) throw new Error(`ya hay una posición en ${state.symbol}`)
    const fundingPaid = [...this.positions.values()].reduce((sum, p) => sum + p.fundingPaid, state.fundingPaid)
    assertRestorable(state, info, { total: this.wallet.total, marginInUse: this.marginInUse(), fundingPaid })
    const liquidationRecalculated = restoredLiquidation(state, info)
    this.positions.set(state.symbol, { ...state, liquidationPrice: liquidationRecalculated?.to ?? state.liquidationPrice })
    this.leverages.set(state.symbol, state.leverage)
    return { liquidationRecalculated }
  }

  // Lo que el saldo no pudo cubrir desde el arranque (ver `Wallet`).
  totalShortfall(): number {
    return this.wallet.totalShortfall
  }

  async placeMarketOrder(req: MarketOrder): Promise<SimulatedFill> {
    const info = this.infoOf(req.symbol)
    assertQty(req.qty, info)
    const { last } = this.pricesOf(req.symbol)
    const at = this.clock()
    const position = this.positions.get(req.symbol)
    if (!position) {
      if (req.reduceOnly) throw new Error(`reduceOnly sin posición en ${req.symbol}`)
      return this.open(info, req, last, at)
    }
    if (positionSideOf(req.side) === position.side) {
      if (req.reduceOnly) throw new Error(`reduceOnly del mismo lado de la posición en ${req.symbol}`)
      throw new Error(`ya hay una posición en ${req.symbol}: el simulador no suma a una posición abierta`)
    }
    const qty = req.reduceOnly ? Math.min(req.qty, position.qty) : req.qty
    if (qty > position.qty) throw new Error(`la orden invertiría la posición en ${req.symbol}: cerrala antes de abrir del otro lado`)
    // Como Binance no deja cerrar un resto bajo los mínimos, el polvo se cierra junto con el parcial.
    const remainderClosed = leavesDust(position.qty, qty, last, info)
    const fill = this.closingFill(position, info, remainderClosed ? position.qty : qty, last, at, false)
    this.settle(position, fill, info)
    return remainderClosed ? { ...fill, remainderClosed: true } : fill
  }

  async placeStopMarket(req: StopOrder): Promise<OrderId> {
    return this.placeConditional('STOP_MARKET', req)
  }

  async placeTakeProfitMarket(req: StopOrder): Promise<OrderId> {
    return this.placeConditional('TAKE_PROFIT_MARKET', req)
  }

  async cancelOrder(symbol: string, orderId: OrderId): Promise<void> {
    this.book.cancel(symbol, orderId)
  }

  // El motivo del cierre es del motor (lo guarda en la posición); al exchange no le cambia nada.
  async closePosition(symbol: string, _reason: CloseReason): Promise<SimulatedFill> {
    const position = this.positions.get(symbol)
    if (!position) throw new Error(`sin posición en ${symbol}`)
    const info = this.infoOf(symbol)
    const { last } = this.pricesOf(symbol)
    const fill = this.closingFill(position, info, position.qty, last, this.clock(), false)
    this.settle(position, fill, info)
    return fill
  }

  async getPositions(): Promise<ExchangePosition[]> {
    return [...this.positions.values()].map((p) => this.view(p))
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    return this.book.list(symbol)
  }

  async getBalance(): Promise<Balance> {
    const views = [...this.positions.values()].map((p) => this.view(p))
    return {
      total: this.wallet.total,
      available: this.availableBalance(),
      marginInUse: this.marginInUse(),
      unrealized: sum(views.map((p) => p.unrealized)),
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.infoOf(symbol)
    if (!(Number.isInteger(leverage) && leverage >= 1)) throw new RangeError(`apalancamiento inválido: ${leverage}`)
    const position = this.positions.get(symbol)
    if (position && position.leverage !== leverage) {
      throw new Error(`no se cambia el apalancamiento con una posición abierta en ${symbol}`)
    }
    this.leverages.set(symbol, leverage)
  }

  onMarkPrice(cb: (tick: MarkTick) => void): Unsubscribe {
    this.markListeners.add(cb)
    return () => this.markListeners.delete(cb)
  }

  onFunding(cb: (ev: FundingEvent) => void): Unsubscribe {
    this.fundingListeners.add(cb)
    return () => this.fundingListeners.delete(cb)
  }

  // Actualiza los precios del símbolo y resuelve, por marca, la liquidación o la
  // primera orden condicional que cruzó. Los suscriptores ven el tick ya resuelto.
  processTick(tick: MarkTick): TriggeredOrder[] {
    this.setPrices(tick.symbol, { mark: tick.markPrice, last: tick.lastPrice })
    const triggered = this.resolveTriggers(tick)
    for (const cb of this.markListeners) cb(tick)
    return triggered ? [triggered] : []
  }

  // Funding de la posición del símbolo: `qty × marca × tasa`, paga el long con tasa
  // positiva y cobra el short. Sale de la billetera, no del margen aislado.
  applyFunding(ev: FundingEvent): FundingApplied[] {
    if (!(Number.isFinite(ev.rate) && isPositive(ev.markPrice))) {
      throw new RangeError(`evento de funding inválido en ${ev.symbol}: tasa ${ev.rate}, marca ${ev.markPrice}`)
    }
    const applied: FundingApplied[] = []
    const position = this.positions.get(ev.symbol)
    if (position) {
      const owed = -direction(position.side) * position.qty * ev.markPrice * ev.rate
      const { applied: amount } = this.wallet.apply(owed)
      this.positions.set(ev.symbol, { ...position, fundingPaid: position.fundingPaid - amount })
      applied.push({ symbol: ev.symbol, side: position.side, qty: position.qty, rate: ev.rate, markPrice: ev.markPrice, amount, at: ev.at })
    }
    for (const cb of this.fundingListeners) cb(ev)
    return applied
  }

  private open(info: SymbolInfo, req: MarketOrder, last: number, at: number): Fill {
    const leverage = this.leverages.get(info.symbol)
    if (leverage === undefined) throw new Error(`sin apalancamiento fijado en ${info.symbol}: setLeverage va antes de abrir`)
    const fill = this.marketFill(info, req.side, req.qty, last, at, false)
    const notional = fill.price * fill.qty
    if (notional < info.minNotional) {
      throw new OrderRejectedError('min_notional', `nocional ${notional} por debajo del minNotional ${info.minNotional} de ${info.symbol}`)
    }
    const margin = notional / leverage
    const available = this.availableBalance()
    if (margin + fill.fee > available) {
      throw new OrderRejectedError('insufficient_margin', `saldo insuficiente para abrir ${info.symbol}: hacen falta ${margin + fill.fee} y hay ${available}`)
    }
    this.wallet.apply(-fill.fee)
    const side = positionSideOf(req.side)
    this.positions.set(info.symbol, {
      symbol: info.symbol,
      side,
      leverage,
      margin,
      notional,
      qty: fill.qty,
      entryPrice: fill.price,
      openedAt: at,
      liquidationPrice: liquidationPrice(side, fill.price, leverage, info.mmr),
      feesPaid: fill.fee,
      fundingPaid: 0,
    })
    return fill
  }

  // Con `closePosition` o con cantidad, al disparar cierra la posición entera: hay una
  // sola por símbolo y el motor manda siempre la cantidad completa.
  private placeConditional(type: OrderType, req: StopOrder): OrderId {
    this.infoOf(req.symbol)
    if (!isPositive(req.stopPrice)) throw new RangeError(`stopPrice inválido: ${req.stopPrice}`)
    const position = this.positions.get(req.symbol)
    if (!position) throw new Error(`sin posición en ${req.symbol} para la orden ${type}`)
    if (req.side !== closingSide(position.side)) {
      throw new Error(`la orden ${type} ${req.side} es del mismo lado de la posición ${position.side} en ${req.symbol}`)
    }
    const { mark } = this.pricesOf(req.symbol)
    const order = { symbol: req.symbol, type, side: req.side, stopPrice: req.stopPrice }
    // Como Binance (error -2021): una orden que ya cruzó la marca se rechaza en vez de llenarse.
    if (orderTriggered(order, mark)) throw new Error(`la orden ${type} a ${req.stopPrice} dispararía de inmediato con la marca en ${mark}`)
    return this.book.place(order)
  }

  private resolveTriggers(tick: MarkTick): TriggeredOrder | null {
    const position = this.positions.get(tick.symbol)
    if (!position) return null
    const info = this.infoOf(tick.symbol)
    const snapshot = this.view(position)
    const base = { symbol: tick.symbol, markPrice: tick.markPrice, position: snapshot }
    // La liquidación va primero: si la marca ya pasó la liquidación, en margen aislado
    // la posición no puede perder más que su margen aunque el mismo tick cruce el stop.
    if (liquidationCrossed(position.side, tick.markPrice, position.liquidationPrice)) {
      const fill = this.liquidationFill(position, tick.at)
      return { ...base, reason: 'liquidation', orderId: null, triggerPrice: position.liquidationPrice, fill, liquidationFeeRate: info.liquidationFee, ...this.settle(position, fill, info) }
    }
    const order = this.book.triggerOrder(tick.symbol).find((o) => orderTriggered(o, tick.markPrice))
    if (!order) return null
    const fill = this.closingFill(position, info, position.qty, tick.lastPrice, tick.at, true)
    const reason = order.type === 'STOP_MARKET' ? 'stop' : 'take_profit'
    return { ...base, reason, orderId: order.id, triggerPrice: order.stopPrice, fill, liquidationFeeRate: null, ...this.settle(position, fill, info) }
  }

  // Fill a mercado sobre el último precio. Las órdenes condicionales pagan un segundo
  // slippage: en total medio spread + 2 × slippage en contra (spec §6).
  private marketFill(info: SymbolInfo, side: OrderSide, qty: number, last: number, at: number, conditional: boolean): Fill {
    const notional = qty * last
    const adverseExtra = conditional ? slippageForNotional(this.risk.slippageRate, notional) : 0
    const { price, spreadCost, slippageCost } = fillPrice({ lastPrice: last, halfSpreadRate: info.halfSpreadRate, slippageRate: this.risk.slippageRate, notional, side, adverseExtra })
    return { symbol: info.symbol, side, price, qty, fee: price * qty * this.risk.takerFeeRate, at, spreadCost, slippageCost }
  }

  // Fill que reduce la posición. En margen aislado la posición no puede perder más que su
  // margen: si `last` está más allá de la quiebra (la marca no liquidó pero el último
  // precio tuvo una mecha), la salida se acota al precio de quiebra. Ahí, como en la
  // liquidación, no hay spread ni slippage que informar: el exceso no lo paga la cuenta.
  private closingFill(position: PositionState, info: SymbolInfo, qty: number, last: number, at: number, conditional: boolean): SimulatedFill {
    const fill = this.marketFill(info, closingSide(position.side), qty, last, at, conditional)
    const bankruptcy = bankruptcyPrice(position.side, position.entryPrice, position.margin, position.qty)
    if (!pastBankruptcy(position.side, fill.price, bankruptcy)) return fill
    const fee = bankruptcy * qty * this.risk.takerFeeRate
    return { ...fill, price: bankruptcy, fee, spreadCost: 0, slippageCost: 0, cappedAtBankruptcy: true }
  }

  // La liquidación se ejecuta al precio de quiebra: pnl bruto = −margen, más la
  // comisión taker de cierre. La `liquidationFee` del contrato sólo se informa.
  private liquidationFill(position: PositionState, at: number): Fill {
    const price = bankruptcyPrice(position.side, position.entryPrice, position.margin, position.qty)
    const fee = price * position.qty * this.risk.takerFeeRate
    return { symbol: position.symbol, side: closingSide(position.side), price, qty: position.qty, fee, at, spreadCost: 0, slippageCost: 0 }
  }

  // Realiza el pnl y la comisión de un fill que reduce la posición. Si la cierra,
  // cancela las órdenes del símbolo: sin posición, un closePosition no tiene qué cerrar.
  private settle(position: PositionState, fill: Fill, info: SymbolInfo): Settlement {
    const pnlGross = direction(position.side) * (fill.price - position.entryPrice) * fill.qty
    const move = this.wallet.apply(pnlGross - fill.fee)
    const remaining = floorToStep(position.qty - fill.qty, info.stepSize)
    if (remaining <= 0) {
      this.positions.delete(position.symbol)
      this.book.cancelAll(position.symbol)
    } else {
      const keep = remaining / position.qty
      this.positions.set(position.symbol, {
        ...position,
        qty: remaining,
        margin: position.margin * keep,
        notional: position.notional * keep,
        feesPaid: position.feesPaid + fill.fee,
      })
    }
    return { pnlGross, realized: move.applied, shortfall: move.shortfall }
  }

  private view(position: PositionState): ExchangePosition {
    const markPrice = this.prices.get(position.symbol)?.mark ?? position.entryPrice
    const unrealized = direction(position.side) * (markPrice - position.entryPrice) * position.qty
    return { ...position, markPrice, unrealized }
  }

  private marginInUse(): number {
    return sum([...this.positions.values()].map((p) => p.margin))
  }

  // En margen aislado el no realizado no suma ni resta disponible: sólo el margen ocupado.
  private availableBalance(): number {
    return Math.max(0, this.wallet.total - this.marginInUse())
  }

  private infoOf(symbol: string): SymbolInfo {
    const info = this.infos[symbol]
    if (!info) throw new Error(`símbolo desconocido: ${symbol}`)
    return info
  }

  private pricesOf(symbol: string): Prices {
    const prices = this.prices.get(symbol)
    if (!prices) throw new Error(`sin precios para ${symbol}: setPrices o processTick van antes de operar`)
    return prices
  }
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}
