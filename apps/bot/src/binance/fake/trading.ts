// La cuenta de futuros del Binance falso: billetera USDT en modo one-way, una posición por
// símbolo, órdenes de mercado que se llenan a la marca con comisión taker y pnl realizado,
// y un libro de órdenes algorítmicas (STOP_MARKET / TAKE_PROFIT_MARKET) que dispara cuando
// el test mueve la marca (`setMark`). Cada cambio sale como evento del user data stream
// con los campos de Binance (`events`, `onEvent`).
//
// Los guiones simulan lo que en Binance de verdad no se puede provocar: rechazos
// (`rejectNext`), fills parciales (`partialFillNext`), respuestas que se cortan con la orden
// ya adentro (`dropResponseNext`), órdenes que vencen sin respuesta y se ejecutan tarde
// (`executeLateNext`), posiciones que Toti abre a mano (`manualPosition`) y liquidaciones
// (`liquidate`).
// Los guiones de ruta sólo los consumen los pedidos que cambian algo (no los GET).
// La validación de cada pedido HTTP vive en `trading-routes.ts`.

import { COMMISSION_RATE, LEVERAGE_BRACKETS } from './account-fixtures'
import { EXCHANGE_INFO } from './fixtures'
import { accountUpdate, algoUpdate, orderUpdate, type AccountPosition, type TradeFill } from './trading-events'
import type { AlgoKind, MarginType, OrderSide, RawAlgoOrder, RawIncome, RawOrder, RawUserEvent, RawUserTrade } from '../trade-types'

export interface FakeTradingConfig {
  dualSide: boolean
  multiAssets: boolean
  feeBurn: boolean
  restrictions: { enableFutures: boolean; enableWithdrawals: boolean; ipRestrict: boolean }
  // Cuánto va adelantado el reloj de Binance respecto del de los tests.
  serverTimeOffsetMs: number
  // Billetera USDT de futuros.
  wallet: number
}

export interface FakePosition {
  amount: number
  entryPrice: number
  // Margen aislado (la billetera de la posición).
  margin: number
}

export interface ContractRules {
  tickSize: number
  stepSize: number
  minNotional: number
  maxQty: number
  maxLeverage: number
  mmr: number
}

// Para rechazar como Binance: el router lo traduce a `{ code, msg }` con su status.
export class FakeBinanceReject extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    msg: string,
  ) {
    super(msg)
  }
}

type PartialScript = { fraction: number; rest: 'expire' } | { fraction: number; rest: 'fill'; price?: number }

export interface MarketRequest {
  symbol: string
  side: OrderSide
  qty: number
  reduceOnly: boolean
  clientOrderId: string
}

const DEFAULT_LEVERAGE = 20
const TAKER_FEE = Number(COMMISSION_RATE.takerCommissionRate)
const CONDITIONAL_TYPES: ReadonlySet<string> = new Set(['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'])

// Mensajes de Binance para los códigos que un test guiona sin texto.
const DEFAULT_MESSAGES: Record<number, string> = {
  [-1001]: 'Internal error; unable to process your request. Please try again.',
  [-1007]: 'Timeout waiting for response from backend server. Send status unknown; execution status unknown.',
  [-1008]: 'Request throttled by system-level protection. Reduce-only/close-position orders are exempt. Please try again.',
  [-2019]: 'Margin is insufficient.',
  [-2021]: 'Order would immediately trigger.',
  [-2022]: 'ReduceOnly Order is rejected.',
  [-4164]: "Order's notional must be no smaller than 5 (unless you choose reduce only).",
}

function defaultTradingConfig(): FakeTradingConfig {
  return {
    dualSide: false,
    multiAssets: false,
    feeBurn: false,
    restrictions: { enableFutures: true, enableWithdrawals: false, ipRestrict: true },
    serverTimeOffsetMs: 0,
    wallet: 1_000,
  }
}

export class FakeTrading {
  // Todo lo que pasó, para que los tests lo inspeccionen.
  readonly orders: RawOrder[] = []
  readonly algos: RawAlgoOrder[] = []
  readonly trades: RawUserTrade[] = []
  readonly income: RawIncome[] = []
  readonly events: RawUserEvent[] = []
  listenKey: string | null = null

  private settings = defaultTradingConfig()
  private wallet = this.settings.wallet
  private readonly positions = new Map<string, FakePosition>()
  private readonly marks = new Map<string, number>()
  private readonly leverages = new Map<string, number>()
  private readonly marginTypes = new Map<string, MarginType>()
  private readonly listeners = new Set<(event: RawUserEvent) => void>()
  private readonly rejects = new Map<string, { code: number; msg: string }[]>()
  private readonly drops = new Map<string, number>()
  private partial: PartialScript | null = null
  private lateNext = 0
  private readonly late: MarketRequest[] = []
  private seq = 0

  // `clock` es el reloj de los tests; el de Binance le suma `serverTimeOffsetMs`.
  constructor(private readonly clock: () => number) {}

  now(): number {
    return this.clock() + this.settings.serverTimeOffsetMs
  }

  get options(): Readonly<FakeTradingConfig> {
    return this.settings
  }

  config(patch: Partial<FakeTradingConfig>): void {
    this.settings = { ...this.settings, ...patch }
    if (patch.wallet !== undefined) this.wallet = patch.wallet
  }

  // ---------- Guiones ----------

  rejectNext(path: string, code: number, msg = DEFAULT_MESSAGES[code] ?? `scripted ${code}`, times = 1): void {
    const queue = this.rejects.get(path) ?? []
    for (let i = 0; i < times; i++) queue.push({ code, msg })
    this.rejects.set(path, queue)
  }

  // La próxima ejecución llena `fraction` de la cantidad; el resto vence (como una MARKET sin
  // liquidez, `EXPIRED`) o se llena en un segundo trade a `price` (por defecto la marca).
  partialFillNext(fraction: number, rest: { rest: 'expire' } | { rest: 'fill'; price?: number } = { rest: 'expire' }): void {
    if (!(fraction > 0 && fraction < 1)) throw new RangeError(`FakeTrading: fracción inválida ${fraction}`)
    this.partial = { fraction, ...rest }
  }

  // El próximo pedido que cambia algo en `path` se procesa, pero la respuesta se corta.
  dropResponseNext(path: string): void {
    this.drops.set(path, (this.drops.get(path) ?? 0) + 1)
  }

  // La próxima orden de mercado vence sin respuesta (−1007: "execution status unknown") y
  // Binance la ejecuta recién con `executeLate`: hasta ahí, consultarla da −2013.
  executeLateNext(): void {
    this.lateNext += 1
  }

  // Ejecuta, en orden, las que vencieron sin respuesta.
  executeLate(): RawOrder[] {
    return this.late.splice(0).map((req) => this.placeMarket(req))
  }

  // Si la orden tenía que vencer sin respuesta, queda guardada y tira el −1007.
  holdIfLate(req: MarketRequest): void {
    if (this.lateNext === 0) return
    this.lateNext -= 1
    this.late.push({ ...req })
    throw new FakeBinanceReject(408, -1007, DEFAULT_MESSAGES[-1007]!)
  }

  takeReject(path: string): { code: number; msg: string } | null {
    return this.rejects.get(path)?.shift() ?? null
  }

  takeDrop(path: string): boolean {
    const pending = this.drops.get(path) ?? 0
    if (pending === 0) return false
    this.drops.set(path, pending - 1)
    return true
  }

  // ---------- Mercado y cuenta ----------

  // Mueve la marca y dispara las algorítmicas que crucen, en orden de creación.
  setMark(symbol: string, price: number): void {
    this.marks.set(symbol, price)
    for (const algo of this.algos) {
      if (algo.symbol === symbol && algo.algoStatus === 'NEW' && crosses(algo, price)) this.trigger(algo, price)
    }
  }

  mark(symbol: string): number {
    const price = this.marks.get(symbol)
    if (price === undefined) throw new FakeBinanceReject(400, -1121, `FakeBinance: ${symbol} sin marca (falta setMark)`)
    return price
  }

  // Lo que Toti abre (positivo) o vende (negativo) a mano, sin id del bot, a la marca.
  manualPosition(symbol: string, amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) throw new RangeError(`FakeTrading: cantidad manual inválida ${amount}`)
    const price = this.mark(symbol)
    const side: OrderSide = amount > 0 ? 'BUY' : 'SELL'
    const order = this.newOrder({ symbol, side, qty: Math.abs(amount), reduceOnly: false, clientOrderId: `web_${this.nextId()}`, origType: 'MARKET' })
    this.emit(orderUpdate(order, 'NEW', order.updateTime, null))
    this.execute(order, Math.abs(amount), price, { scripted: false })
  }

  // Binance liquida la posición entera a su precio de liquidación (o a `price`): la marca salta
  // ahí sin pasar por las algorítmicas (un hueco) y la orden lleva el id `autoclose-…`. Como
  // Binance, antes cancela las algorítmicas abiertas de la moneda: sus ALGO_UPDATE (EXPIRED)
  // salen antes que la orden de liquidación.
  liquidate(symbol: string, price = this.liquidationPrice(symbol)): void {
    const position = this.positions.get(symbol)
    if (!position || price === null) throw new Error(`FakeTrading: ${symbol} sin posición para liquidar`)
    const at = this.now()
    for (const algo of this.algos) {
      if (algo.symbol !== symbol || algo.algoStatus !== 'NEW') continue
      algo.algoStatus = 'EXPIRED'
      algo.updateTime = at
      this.emit(algoUpdate(algo, at))
    }
    this.marks.set(symbol, price)
    const qty = Math.abs(position.amount)
    const side: OrderSide = position.amount > 0 ? 'SELL' : 'BUY'
    const order = this.newOrder({ symbol, side, qty, reduceOnly: true, clientOrderId: `autoclose-${this.now()}`, origType: 'MARKET' })
    this.emit(orderUpdate(order, 'NEW', order.updateTime, null))
    this.execute(order, qty, price, { scripted: false })
  }

  // Cobra (o paga) el funding de la posición abierta a la marca: `income = −amount·marca·tasa`.
  chargeFunding(symbol: string, rate: number): void {
    const position = this.positions.get(symbol)
    if (!position) throw new Error(`FakeTrading: ${symbol} sin posición para cobrar funding`)
    const amount = -position.amount * this.mark(symbol) * rate
    this.wallet += amount
    // En aislado el funding sale de (o entra a) la billetera de la posición.
    if (this.marginType(symbol) === 'isolated') position.margin += amount
    const at = this.now()
    this.income.push({ symbol, incomeType: 'FUNDING_FEE', income: plain(amount), asset: 'USDT', info: 'FUNDING_FEE', time: at, tranId: this.nextId(), tradeId: '' })
    this.emit(accountUpdate('FUNDING_FEE', at, plain(this.wallet), [this.accountPosition(symbol)], symbol))
  }

  position(symbol: string): FakePosition | null {
    const p = this.positions.get(symbol)
    return p ? { ...p } : null
  }

  symbolsWithPosition(): string[] {
    return [...this.positions.keys()]
  }

  leverage(symbol: string): number {
    return this.leverages.get(symbol) ?? DEFAULT_LEVERAGE
  }

  marginType(symbol: string): MarginType {
    return this.marginTypes.get(symbol) ?? 'cross'
  }

  walletBalance(): number {
    return this.wallet
  }

  // Billetera menos el margen de todas las posiciones.
  available(): number {
    let used = 0
    for (const p of this.positions.values()) used += p.margin
    return this.wallet - used
  }

  setMarginType(symbol: string, type: MarginType): void {
    if (this.marginType(symbol) === type) throw new FakeBinanceReject(400, -4046, 'No need to change margin type.')
    if (this.positions.has(symbol)) throw new FakeBinanceReject(400, -4048, 'Margin type cannot be changed if there exists position.')
    if (this.algos.some((a) => a.symbol === symbol && a.algoStatus === 'NEW')) throw new FakeBinanceReject(400, -4047, 'Margin type cannot be changed if there exists open orders.')
    this.marginTypes.set(symbol, type)
  }

  setLeverage(symbol: string, leverage: number): void {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > contractRules(symbol).maxLeverage) throw new FakeBinanceReject(400, -4028, `Leverage ${leverage} is not valid`)
    this.leverages.set(symbol, leverage)
  }

  // ---------- Órdenes ----------

  // Una MARKET ya validada por el router: se llena a la marca (o lo que diga el guion).
  placeMarket(req: MarketRequest): RawOrder {
    const price = this.mark(req.symbol)
    const rules = contractRules(req.symbol)
    const fillable = req.reduceOnly ? this.reducible(req.symbol, req.side) : req.qty
    if (req.reduceOnly && fillable === 0) throw new FakeBinanceReject(400, -2022, DEFAULT_MESSAGES[-2022]!)
    if (!req.reduceOnly) {
      if (req.qty * price < rules.minNotional) throw new FakeBinanceReject(400, -4164, `Order's notional must be no smaller than ${rules.minNotional} (unless you choose reduce only)`)
      const opening = req.qty - this.reducible(req.symbol, req.side)
      const required = (Math.max(0, opening) * price) / this.leverage(req.symbol) + req.qty * price * TAKER_FEE
      if (required > this.available()) throw new FakeBinanceReject(400, -2019, DEFAULT_MESSAGES[-2019]!)
    }
    const order = this.newOrder({ ...req, origType: 'MARKET' })
    this.emit(orderUpdate(order, 'NEW', order.updateTime, null))
    return this.execute(order, Math.min(req.qty, fillable), price, { scripted: true })
  }

  placeAlgo(req: { symbol: string; side: OrderSide; type: AlgoKind; triggerPrice: string; quantity: string; reduceOnly: boolean; workingType: string; priceProtect: boolean; clientAlgoId: string }): RawAlgoOrder {
    const price = this.mark(req.symbol)
    if (this.algos.some((a) => a.clientAlgoId === req.clientAlgoId && a.algoStatus === 'NEW')) throw new FakeBinanceReject(400, -4116, 'clientOrderId is duplicated')
    const at = this.now()
    const algo: RawAlgoOrder = {
      algoId: this.nextId(),
      clientAlgoId: req.clientAlgoId,
      algoType: 'CONDITIONAL',
      orderType: req.type,
      symbol: req.symbol,
      side: req.side,
      positionSide: 'BOTH',
      timeInForce: 'GTC',
      quantity: req.quantity,
      algoStatus: 'NEW',
      actualOrderId: '',
      actualPrice: '0',
      actualType: '',
      actualQty: '0',
      triggerPrice: req.triggerPrice,
      price: '0',
      icebergQuantity: null,
      selfTradePreventionMode: 'EXPIRE_MAKER',
      workingType: req.workingType,
      priceMatch: 'NONE',
      closePosition: false,
      priceProtect: req.priceProtect,
      reduceOnly: req.reduceOnly,
      createTime: at,
      updateTime: at,
      triggerTime: 0,
      goodTillDate: 0,
    }
    if (crosses(algo, price)) throw new FakeBinanceReject(400, -2021, DEFAULT_MESSAGES[-2021]!)
    this.algos.push(algo)
    this.emit(algoUpdate(algo, at))
    return algo
  }

  cancelAlgo(find: { algoId?: number; clientAlgoId?: string }): RawAlgoOrder {
    const algo = this.findAlgo(find)
    if (!algo || algo.algoStatus !== 'NEW') throw new FakeBinanceReject(400, -2011, 'Unknown order sent.')
    algo.algoStatus = 'CANCELED'
    algo.updateTime = this.now()
    this.emit(algoUpdate(algo, algo.updateTime))
    return algo
  }

  // La última con ese id (un id de cliente se puede repetir una vez llena la anterior).
  findOrder(symbol: string, find: { orderId?: number; clientOrderId?: string }): RawOrder | undefined {
    return this.orders.findLast((o) => o.symbol === symbol && (find.orderId !== undefined ? o.orderId === find.orderId : o.clientOrderId === find.clientOrderId))
  }

  findAlgo(find: { algoId?: number; clientAlgoId?: string }): RawAlgoOrder | undefined {
    return this.algos.findLast((a) => (find.algoId !== undefined ? a.algoId === find.algoId : a.clientAlgoId === find.clientAlgoId))
  }

  onEvent(listener: (event: RawUserEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Precio de liquidación de una posición aislada (tier 1, `cum = 0`); null sin posición.
  liquidationPrice(symbol: string): number | null {
    const p = this.positions.get(symbol)
    if (!p) return null
    const { mmr } = contractRules(symbol)
    const qty = Math.abs(p.amount)
    const price = p.amount > 0 ? (qty * p.entryPrice - p.margin) / (qty * (1 - mmr)) : (p.margin + qty * p.entryPrice) / (qty * (1 + mmr))
    return Math.max(0, price)
  }

  // ---------- Internos ----------

  private accountPosition(symbol: string): AccountPosition {
    const p = this.positions.get(symbol)
    const unrealized = p ? p.amount * (this.mark(symbol) - p.entryPrice) : 0
    const marginType = this.marginType(symbol)
    return {
      symbol,
      amount: plain(p?.amount ?? 0),
      entryPrice: plain(p?.entryPrice ?? 0),
      unrealized: plain(unrealized),
      marginType,
      isolatedWallet: marginType === 'isolated' ? plain(p?.margin ?? 0) : '0',
    }
  }

  private nextId(): number {
    return ++this.seq
  }

  // Cuánto de la posición abierta reduce una orden de ese lado (0 si la agranda).
  private reducible(symbol: string, side: OrderSide): number {
    const amount = this.positions.get(symbol)?.amount ?? 0
    if (amount > 0 && side === 'SELL') return amount
    if (amount < 0 && side === 'BUY') return -amount
    return 0
  }

  private newOrder(req: { symbol: string; side: OrderSide; qty: number; reduceOnly: boolean; clientOrderId: string; origType: string }): RawOrder {
    const at = this.now()
    const order: RawOrder = {
      orderId: this.nextId(),
      symbol: req.symbol,
      status: 'NEW',
      clientOrderId: req.clientOrderId,
      price: '0',
      avgPrice: '0',
      origQty: plain(req.qty),
      executedQty: '0',
      cumQty: '0',
      cumQuote: '0',
      timeInForce: 'GTC',
      type: 'MARKET',
      reduceOnly: req.reduceOnly,
      closePosition: false,
      side: req.side,
      positionSide: 'BOTH',
      stopPrice: '0',
      workingType: 'CONTRACT_PRICE',
      priceProtect: false,
      origType: req.origType,
      priceMatch: 'NONE',
      selfTradePreventionMode: 'EXPIRE_MAKER',
      goodTillDate: 0,
      time: at,
      updateTime: at,
    }
    this.orders.push(order)
    return order
  }

  // Llena `qty` de la orden a `price`, o lo que diga el guion de fill parcial.
  private execute(order: RawOrder, qty: number, price: number, { scripted }: { scripted: boolean }): RawOrder {
    const at = this.now()
    const { stepSize } = contractRules(order.symbol)
    const partial = scripted ? this.partial : null
    if (scripted) this.partial = null
    const legs: { qty: number; price: number }[] = []
    if (partial) {
      const first = floorToStep(qty * partial.fraction, stepSize)
      if (first > 0) legs.push({ qty: first, price })
      if (partial.rest === 'fill') legs.push({ qty: round(qty - first), price: partial.price ?? price })
    } else if (qty > 0) {
      legs.push({ qty, price })
    }
    let filled = 0
    let quote = 0
    for (const leg of legs) {
      const fill = this.fill(order, leg.qty, leg.price, at)
      filled = round(filled + leg.qty)
      quote += leg.qty * leg.price
      order.executedQty = plain(filled)
      order.cumQty = plain(filled)
      order.cumQuote = plain(quote)
      order.avgPrice = plain(quote / filled)
      order.status = filled < Number(order.origQty) ? 'PARTIALLY_FILLED' : 'FILLED'
      order.updateTime = at
      this.emit(orderUpdate(order, 'TRADE', at, fill))
    }
    if (filled > 0) this.emit(accountUpdate('ORDER', at, plain(this.wallet), [this.accountPosition(order.symbol)]))
    if (filled < Number(order.origQty)) {
      // MARKET sin completar (falta liquidez o el reduceOnly no tenía más que reducir).
      order.status = 'EXPIRED'
      order.updateTime = at
      this.emit(orderUpdate(order, 'EXPIRED', at, null, filled > 0 ? '9' : '4'))
    }
    return order
  }

  // Un trade: mueve la posición, realiza pnl de lo que reduce, cobra la comisión taker.
  private fill(order: RawOrder, qty: number, price: number, at: number): TradeFill {
    const { symbol, side } = order
    const current = this.positions.get(symbol)
    const amount = current?.amount ?? 0
    const signedQty = side === 'BUY' ? qty : -qty
    const closing = Math.min(this.reducible(symbol, side), qty)
    const realized = current ? closing * (price - current.entryPrice) * Math.sign(amount) : 0
    const commission = qty * price * TAKER_FEE
    const next = round(amount + signedQty)
    // Lo que se reduce libera su parte del margen; lo que se abre pone `nocional / apalancamiento`.
    let margin = current ? (current.margin * (Math.abs(amount) - closing)) / Math.abs(amount) : 0
    let entryPrice = current?.entryPrice ?? price
    const opening = qty - closing
    if (opening > 0) {
      const kept = Math.abs(amount) - closing
      entryPrice = kept > 0 ? (kept * entryPrice + opening * price) / (kept + opening) : price
      margin += (opening * price) / this.leverage(symbol)
    }
    if (next === 0) this.positions.delete(symbol)
    else this.positions.set(symbol, { amount: next, entryPrice, margin })
    this.wallet += realized - commission

    const tradeId = this.nextId()
    this.trades.push({
      buyer: side === 'BUY',
      commission: plain(commission),
      commissionAsset: 'USDT',
      id: tradeId,
      maker: false,
      orderId: order.orderId,
      price: plain(price),
      qty: plain(qty),
      quoteQty: plain(qty * price),
      realizedPnl: plain(realized),
      side,
      positionSide: 'BOTH',
      symbol,
      time: at,
    })
    return { qty: plain(qty), price: plain(price), commission: plain(commission), realizedPnl: plain(realized), tradeId }
  }

  // Dispara: el algo pasa a TRIGGERING y TRIGGERED con la orden de mercado que nace (con
  // un id de cliente propio de Binance: se vincula por `actualOrderId`), se llena a la marca
  // y queda FINISHED. Un reduceOnly sin nada que reducir vence sin llenar.
  private trigger(algo: RawAlgoOrder, price: number): void {
    const at = this.now()
    algo.algoStatus = 'TRIGGERING'
    algo.triggerTime = at
    algo.updateTime = at
    this.emit(algoUpdate(algo, at))
    const qty = Number(algo.quantity)
    const order = this.newOrder({ symbol: algo.symbol, side: algo.side, qty, reduceOnly: algo.reduceOnly, clientOrderId: `algo_${algo.algoId}`, origType: algo.orderType })
    algo.algoStatus = 'TRIGGERED'
    algo.actualOrderId = String(order.orderId)
    algo.actualType = 'MARKET'
    this.emit(algoUpdate(algo, at))
    this.emit(orderUpdate(order, 'NEW', at, null))
    const fillable = algo.reduceOnly ? Math.min(qty, this.reducible(algo.symbol, algo.side)) : qty
    this.execute(order, fillable, price, { scripted: true })
    algo.algoStatus = 'FINISHED'
    algo.actualQty = order.executedQty
    algo.actualPrice = order.avgPrice ?? '0'
    algo.updateTime = at
    this.emit(algoUpdate(algo, at))
  }

  private emit(event: RawUserEvent): void {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
  }
}

// ¿La marca `price` dispara (o dispararía en el acto) este algo? Reglas de Binance:
// STOP compra con precio ≥ disparo y vende con ≤; TAKE_PROFIT al revés.
function crosses(algo: RawAlgoOrder, price: number): boolean {
  const trigger = Number(algo.triggerPrice)
  const up = price >= trigger
  const down = price <= trigger
  if (algo.orderType === 'STOP_MARKET') return algo.side === 'BUY' ? up : down
  return algo.side === 'BUY' ? down : up
}

export function isConditionalType(type: string): boolean {
  return CONDITIONAL_TYPES.has(type)
}

export function contractRules(symbol: string): ContractRules {
  const contract = EXCHANGE_INFO.symbols.find((s) => s.symbol === symbol)
  if (!contract) throw new FakeBinanceReject(400, -1121, 'Invalid symbol.')
  const rules: ContractRules = { tickSize: 0, stepSize: 0, minNotional: 0, maxQty: Number.POSITIVE_INFINITY, maxLeverage: DEFAULT_LEVERAGE, mmr: 0.005 }
  for (const f of contract.filters) {
    if (f.filterType === 'PRICE_FILTER') rules.tickSize = Number(f.tickSize)
    else if (f.filterType === 'LOT_SIZE') rules.stepSize = Number(f.stepSize)
    else if (f.filterType === 'MARKET_LOT_SIZE') rules.maxQty = Number(f.maxQty)
    else if (f.filterType === 'MIN_NOTIONAL') rules.minNotional = Number(f.notional)
  }
  const tier = LEVERAGE_BRACKETS.find((b) => b.symbol === symbol)?.brackets.find((b) => b.notionalFloor === 0)
  if (tier) {
    rules.maxLeverage = tier.initialLeverage
    rules.mmr = tier.maintMarginRatio
  }
  return rules
}

// ¿`value` cae en la grilla `step`? (con la tolerancia de la coma flotante)
export function onGrid(value: number, step: number): boolean {
  const units = value / step
  return Math.abs(units - Math.round(units)) < 1e-9
}

function floorToStep(value: number, step: number): number {
  return round(Math.floor(value / step + 1e-9) * step)
}

// Sin el ruido de la coma flotante (0.1 + 0.2): las cantidades del falso tienen pocos decimales.
function round(value: number): number {
  return Math.round(value * 1e10) / 1e10
}

// Número como lo escribe Binance: decimal, sin exponente ni ceros de más.
export function plain(value: number): string {
  if (value === 0) return '0'
  return value.toFixed(10).replace(/\.?0+$/, '')
}
