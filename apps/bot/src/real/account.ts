// La cuenta de Binance de la sesión real, vista por REST y por el user data stream: posiciones
// y algorítmicas de la sesión (por el prefijo de sus ids de cliente), los fills de sus órdenes
// y los disparos de sus stops y take profits (más las liquidaciones donde tiene algos, o los
// tenía hasta que Binance los canceló al liquidar; ver `live-book.ts`). No decide nada: el
// adaptador del exchange y la reconciliación leen de acá.
//
// El stream es la vía rápida; REST cubre lo que el stream no trae a tiempo (`awaitOrderFill`
// completa por `userTrades`) y lo que se pierde en un corte (`resync`).

import type { Logger } from 'pino'
import type { BinanceTradeRest } from '../binance/trade-rest'
import { classifyBinanceError } from '../binance/trade-errors'
import type { AccountUpdate, AlgoOrder, AlgoUpdate, BinancePosition, OrderTradeUpdate } from '../binance/trade-types'
import type { UserDataStream } from '../binance/user-stream'
import type { Clock, TimerHandle } from '../live/timers'
import { silentLogger } from '../logger'
import { parseClientId, sessionShort } from './client-id'
import { LiveBook, type LivePosition } from './live-book'
import { OrderTracker, restFill, streamFill, type OrderFill, type TrackedOrder } from './order-tracker'

export type { LivePosition } from './live-book'
export type { OrderFill } from './order-tracker'

export type TradeApi = Pick<BinanceTradeRest, 'positionRisk' | 'openAlgoOrders' | 'queryOrder' | 'userTrades'>
export type UserStreamLike = Pick<UserDataStream, 'on' | 'start' | 'stop' | 'connected'>

// Binance no tiene la orden pedida: nunca entró (o venció hace más de 3 días sin trades).
export class OrderNotFoundError extends Error {
  override readonly name = 'OrderNotFoundError'
}

// La cuenta se detuvo (el bot se apaga): no es una falla de Binance.
export class AccountStoppedError extends Error {
  override readonly name = 'AccountStoppedError'
}

export interface SyncSnapshot {
  // Reloj local al mandar los pedidos: la foto vale al menos desde acá.
  at: number
  positions: Map<string, BinancePosition>
  botAlgos: AlgoOrder[]
}

export interface TriggeredFill {
  symbol: string
  // El algo que disparó; en una liquidación, el stop del bot en esa moneda.
  clientAlgoId: string
  fill: OrderFill
  liquidation: boolean
}

export interface RealAccountOptions {
  trade: TradeApi
  stream: UserStreamLike
  sessionId: string
  clock: Clock
  logger?: Logger
  // Cuánto espera `start` la primera conexión del stream antes de sincronizar igual.
  connectTimeoutMs?: number
}

interface Waiter {
  symbol: string
  clientOrderId: string
  resolve: (fill: OrderFill) => void
  reject: (err: unknown) => void
  timer: TimerHandle
}

// Una orden que nació de un algo del bot (o lo liquidó): se avisa una vez, al quedar final.
interface TriggerLink {
  symbol: string
  clientAlgoId: string
  liquidation: boolean
  delivered: boolean
  seenAt: number
}

// Lo que nadie reclamó (una orden de Toti, un vínculo ya avisado) se olvida a los 10 min.
const RETAIN_MS = 10 * 60_000
// Por REST, una orden que todavía no es final (o cuyos trades no suman lo ejecutado) se vuelve
// a pedir un par de veces, un segundo después cada vez; un error pasajero de Binance (red,
// 5xx, límite) gasta un intento del mismo presupuesto.
const REST_ATTEMPTS = 3
const REST_RETRY_MS = 1_000

export class RealAccount {
  private readonly trade: TradeApi
  private readonly stream: UserStreamLike
  private readonly short: string
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly connectTimeoutMs: number
  private readonly book: LiveBook
  private readonly orders: OrderTracker
  private readonly links = new Map<number, TriggerLink>()
  private readonly waiters = new Set<Waiter>()
  private readonly listeners = {
    triggered: new Set<(t: TriggeredFill) => void>(),
    resync: new Set<(snapshot: SyncSnapshot) => void>(),
    fatal: new Set<(err: Error) => void>(),
    account: new Set<(u: AccountUpdate) => void>(),
  }
  private stopped = false
  // `start` sincronizó sin stream: al conectar hay que volver a sincronizar.
  private missedConnect = false
  private resyncWanted = false
  private resyncBusy = false

  constructor(opts: RealAccountOptions) {
    this.trade = opts.trade
    this.stream = opts.stream
    this.short = sessionShort(opts.sessionId)
    this.clock = opts.clock
    this.logger = opts.logger ?? silentLogger
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000
    this.book = new LiveBook(this.clock.now)
    this.orders = new OrderTracker(this.clock.now, RETAIN_MS, (order) => this.isClaimed(order))
    this.stream.on('order', (u) => this.onOrder(u))
    this.stream.on('algo', (u) => this.onAlgo(u))
    this.stream.on('account', (u) => this.onAccount(u))
    this.stream.on('resync', () => this.requestResync())
    this.stream.on('status', (status) => {
      if (status !== 'connected' || !this.missedConnect) return
      this.missedConnect = false
      this.requestResync()
    })
  }

  get streamUp(): boolean {
    return this.stream.connected
  }

  // El stream primero, así el sync no deja un hueco entre la foto y el primer evento.
  async start(): Promise<void> {
    this.stream.start()
    await this.waitConnected()
    await this.sync()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const waiter of this.waiters) {
      this.clock.timers.clearTimeout(waiter.timer)
      waiter.reject(new AccountStoppedError(`La cuenta real se detuvo antes de saber cómo se llenó ${waiter.clientOrderId}`))
    }
    this.waiters.clear()
    await this.stream.stop()
  }

  async sync(): Promise<SyncSnapshot> {
    const at = this.clock.now()
    const mark = this.book.beginSync()
    let positions: BinancePosition[]
    let algos: AlgoOrder[]
    try {
      ;[positions, algos] = await Promise.all([this.trade.positionRisk(), this.trade.openAlgoOrders()])
    } catch (err) {
      this.book.abandonSync(mark)
      throw err
    }
    const botAlgos = algos.filter((a) => this.owns(a.clientAlgoId))
    this.book.endSync(mark, positions, botAlgos)
    return { at, positions: new Map(positions.map((p) => [p.symbol, p])), botAlgos }
  }

  position(symbol: string): LivePosition | null {
    return this.book.position(symbol)
  }

  botAlgos(symbol?: string): AlgoOrder[] {
    return this.book.algosOf(symbol)
  }

  // Los eventos de la orden hasta su estado final; vencido el plazo, lo que diga REST. Si REST
  // tampoco la tiene completa después de los reintentos, devuelve lo que hay con
  // `complete: false`: quien llama mira `status` (puede no ser final), la cantidad y completa
  // la comisión que falte.
  awaitOrderFill(symbol: string, clientOrderId: string, timeoutMs: number): Promise<OrderFill> {
    if (this.stopped) return Promise.reject(new AccountStoppedError(`La cuenta real está detenida: no puedo esperar ${clientOrderId}`))
    const known = this.orders.byClientId(symbol, clientOrderId)
    if (known?.final) {
      this.orders.forget(known.orderId)
      return new Promise((resolve) => resolve(streamFill(known)))
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        symbol,
        clientOrderId,
        resolve,
        reject,
        timer: this.clock.timers.setTimeout(() => void this.pollRest(waiter, 1), timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  onTriggered(cb: (t: TriggeredFill) => void): () => void {
    return subscribe(this.listeners.triggered, cb)
  }

  // Después de cada reconexión del stream, con la foto del sync que la cubre.
  onResync(cb: (snapshot: SyncSnapshot) => void): () => void {
    return subscribe(this.listeners.resync, cb)
  }

  // Lo que llega por el stream y no tiene a quién devolverle el error (un disparo con la
  // comisión en otra moneda): quien escucha apaga la sesión real.
  onFatal(cb: (err: Error) => void): () => void {
    return subscribe(this.listeners.fatal, cb)
  }

  // Cada ACCOUNT_UPDATE, ya aplicado a las posiciones (el funding lo cobra quien escucha).
  onAccountUpdate(cb: (u: AccountUpdate) => void): () => void {
    return subscribe(this.listeners.account, cb)
  }

  // ---------- eventos ----------

  private onOrder(u: OrderTradeUpdate): void {
    const order = this.orders.apply(u)
    if (u.liquidation && !this.links.has(u.orderId)) {
      const algo = this.book.protectiveAlgo(u.symbol)
      if (algo) this.link(u.orderId, u.symbol, algo.clientAlgoId, true)
    }
    if (!order.final) return
    this.settleWaiters(order)
    this.deliverTriggered(u.orderId)
  }

  private onAlgo(u: AlgoUpdate): void {
    if (!this.owns(u.clientAlgoId)) return
    this.book.applyAlgo(u)
    if (u.triggeredOrderId === null || this.links.has(u.triggeredOrderId)) return
    this.link(u.triggeredOrderId, u.symbol, u.clientAlgoId, false)
    this.deliverTriggered(u.triggeredOrderId)
  }

  private onAccount(u: AccountUpdate): void {
    this.book.applyAccount(u)
    this.emit(this.listeners.account, u)
  }

  private link(orderId: number, symbol: string, clientAlgoId: string, liquidation: boolean): void {
    const cutoff = this.clock.now() - RETAIN_MS
    for (const [id, link] of this.links) if (link.seenAt < cutoff) this.links.delete(id)
    this.links.set(orderId, { symbol, clientAlgoId, liquidation, delivered: false, seenAt: this.clock.now() })
  }

  private settleWaiters(order: TrackedOrder): void {
    let claimed = false
    for (const waiter of this.waiters) {
      if (waiter.symbol !== order.symbol || waiter.clientOrderId !== order.clientOrderId) continue
      claimed = true
      this.waiters.delete(waiter)
      this.clock.timers.clearTimeout(waiter.timer)
      try {
        waiter.resolve(streamFill(order))
      } catch (err) {
        waiter.reject(err)
      }
    }
    if (claimed) this.orders.forget(order.orderId)
  }

  // Un disparo que vence sin llenarse (ya no había nada que reducir) no se avisa.
  private deliverTriggered(orderId: number): void {
    const link = this.links.get(orderId)
    const order = this.orders.get(orderId)
    if (!link || link.delivered || !order?.final) return
    link.delivered = true
    this.orders.forget(orderId)
    if (order.cumQty === 0) return
    let fill: OrderFill
    try {
      fill = streamFill(order)
    } catch (err) {
      this.fatal(err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.emit(this.listeners.triggered, { symbol: link.symbol, clientAlgoId: link.clientAlgoId, fill, liquidation: link.liquidation })
  }

  private fatal(err: Error): void {
    this.logger.error({ err: err.message }, 'RealAccount: error fatal en un evento del stream')
    this.emit(this.listeners.fatal, err)
  }

  // ---------- REST ----------

  // La espera sigue anotada mientras pregunta: si el stream la completa antes, gana el stream
  // (y `stop` la corta igual que antes del plazo).
  private async pollRest(waiter: Waiter, attempt: number): Promise<void> {
    let fill: OrderFill
    try {
      fill = await this.fillFromRest(waiter.symbol, waiter.clientOrderId)
    } catch (err) {
      if (!this.waiters.has(waiter)) return
      const classified = classifyBinanceError(err)
      if (classified.kind === 'retryable' && attempt < REST_ATTEMPTS) {
        this.logger.warn({ symbol: waiter.symbol, clientOrderId: waiter.clientOrderId, attempt, err: classified.message }, 'RealAccount: falló la consulta de la orden por REST; se reintenta')
        this.retryRest(waiter, attempt)
        return
      }
      this.waiters.delete(waiter)
      waiter.reject(err)
      return
    }
    if (!this.waiters.has(waiter)) return
    if (fill.complete || attempt >= REST_ATTEMPTS) {
      this.waiters.delete(waiter)
      if (!fill.complete) {
        const { qty, status } = fill
        this.logger.warn({ symbol: waiter.symbol, clientOrderId: waiter.clientOrderId, qty, status, attempts: attempt }, 'RealAccount: REST no tiene la orden completa (estado no final o faltan trades); se devuelve lo que hay, marcado incompleto')
      }
      waiter.resolve(fill)
      return
    }
    this.retryRest(waiter, attempt)
  }

  private retryRest(waiter: Waiter, attempt: number): void {
    waiter.timer = this.clock.timers.setTimeout(() => void this.pollRest(waiter, attempt + 1), REST_RETRY_MS)
  }

  private async fillFromRest(symbol: string, clientOrderId: string): Promise<OrderFill> {
    const ack = await this.trade.queryOrder(symbol, clientOrderId)
    if (ack === null) throw new OrderNotFoundError(`Binance no tiene la orden ${clientOrderId} de ${symbol}`)
    const trades = ack.executedQty > 0 ? await this.trade.userTrades(symbol, { orderId: ack.orderId }) : []
    return restFill(ack, trades)
  }

  // Una orden que alguien espera (un fill pedido o un disparo todavía sin avisar).
  private isClaimed(order: TrackedOrder): boolean {
    const link = this.links.get(order.orderId)
    if (link && !link.delivered) return true
    for (const waiter of this.waiters) if (waiter.symbol === order.symbol && waiter.clientOrderId === order.clientOrderId) return true
    return false
  }

  private async waitConnected(): Promise<void> {
    if (this.stream.connected) return
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        off()
        this.clock.timers.clearTimeout(timer)
        resolve()
      }
      const off = this.stream.on('status', (status) => {
        if (status === 'connected') finish()
      })
      const timer = this.clock.timers.setTimeout(() => {
        this.missedConnect = true
        this.logger.warn({ timeoutMs: this.connectTimeoutMs }, 'RealAccount: el user data stream no conectó a tiempo; se sincroniza por REST y otra vez al conectar')
        finish()
      }, this.connectTimeoutMs)
    })
  }

  // Los pedidos que llegan juntos comparten un sync; los que llegan con uno en curso, otro más.
  private requestResync(): void {
    this.resyncWanted = true
    if (this.resyncBusy) return
    this.resyncBusy = true
    queueMicrotask(() => void this.runResyncs())
  }

  private async runResyncs(): Promise<void> {
    try {
      while (this.resyncWanted && !this.stopped) {
        this.resyncWanted = false
        try {
          const snapshot = await this.sync()
          this.emit(this.listeners.resync, snapshot)
        } catch (err) {
          this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RealAccount: falló el sync después de reconectar; lo cubre la reconciliación periódica')
        }
      }
    } finally {
      this.resyncBusy = false
    }
  }

  private owns(clientId: string): boolean {
    return parseClientId(clientId)?.short === this.short
  }

  private emit<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const cb of listeners) {
      try {
        cb(value)
      } catch (err) {
        this.logger.error({ err }, 'RealAccount: un handler lanzó una excepción')
      }
    }
  }
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}
