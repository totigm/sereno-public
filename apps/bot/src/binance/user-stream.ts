// El user data stream de Binance USDT-M para la sesión real: pide el listenKey, se conecta a
// `<url>/<listenKey>` (en mainnet `wss://fstream.binance.com/private/ws`; ver la cabecera de
// `trade-types.ts`) y emite normalizados los `ORDER_TRADE_UPDATE`, `ALGO_UPDATE` y
// `ACCOUNT_UPDATE`. Renueva el listenKey cada 30 min (vale 60), reconecta solo con backoff y,
// después de cada reconexión o de un listenKey vencido, emite `resync`: lo que pasó sin
// conexión no se vuelve a mandar, así que quien escucha reconcilia por REST. Un evento
// conocido que llega mal formado también se perdió: también emite `resync`.
//
// La primera conexión no emite `resync`: quien arranca hace su propia sincronización. Si esa
// primera conexión falla, la que finalmente abre sí lo emite.
//
// El listenKey da acceso a los eventos de la cuenta: nunca va a los logs (ni la URL).

import { WebSocket, type RawData } from 'ws'
import type { Logger } from 'pino'
import { realClock, type Clock, type TimerHandle } from '../live/timers'
import { silentLogger } from '../logger'
import { BinanceHttpError } from './errors'
import type { BinanceTradeRest } from './trade-rest'
import { classifyBinanceError } from './trade-errors'
import type { AccountUpdate, AlgoUpdate, OrderTradeUpdate } from './trade-types'
import { parseUserEvent, type UserEvent } from './user-events'
import { closeSocket, rawToString, type StreamSocket, type StreamSocketFactory } from './ws'

export type UserStreamStatus = 'connected' | 'reconnecting' | 'closed'

export interface UserDataStreamEvents {
  order: (update: OrderTradeUpdate) => void
  algo: (update: AlgoUpdate) => void
  account: (update: AccountUpdate) => void
  status: (status: UserStreamStatus) => void
  resync: () => void
}

export interface UserDataStreamOptions {
  trade: Pick<BinanceTradeRest, 'listenKeyCreate' | 'listenKeyKeepAlive' | 'listenKeyClose'>
  // La ruta privada sin el listenKey.
  url: string
  WebSocket?: StreamSocketFactory
  clock?: Clock
  logger?: Logger
  keepAliveMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  // Binance manda un ping cada 3 min: sin ping ni mensaje en este lapso la conexión está muerta
  // (un stream de cuenta puede pasar horas sin eventos, así que el silencio solo no alcanza).
  staleAfterMs?: number
  handshakeTimeoutMs?: number
}

// −1125: el listenKey no existe (venció o lo cerraron).
const LISTEN_KEY_MISSING = -1125

interface Link {
  socket: StreamSocket
  listenKey: string
}

type Listeners = { [K in keyof UserDataStreamEvents]: Set<UserDataStreamEvents[K]> }

export class UserDataStream {
  private readonly trade: UserDataStreamOptions['trade']
  private readonly base: string
  private readonly SocketImpl: StreamSocketFactory
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly keepAliveMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly staleAfterMs: number
  private readonly handshakeTimeoutMs: number

  private readonly listeners: Listeners = { order: new Set(), algo: new Set(), account: new Set(), status: new Set(), resync: new Set() }
  private link: Link | null = null
  // El último listenKey creado, para cerrarlo al parar.
  private listenKey: string | null = null
  // Cambia en cada start/stop: una continuación de una vuelta anterior no toca nada.
  private run = 0
  private stopped = true
  private attempts = 0
  private resyncPending = false
  private currentStatus: UserStreamStatus = 'closed'
  private timers: { keepAlive?: TimerHandle; stale?: TimerHandle; backoff?: TimerHandle } = {}

  constructor(opts: UserDataStreamOptions) {
    this.trade = opts.trade
    this.base = opts.url.replace(/\/+$/, '')
    this.SocketImpl = opts.WebSocket ?? WebSocket
    this.clock = opts.clock ?? realClock
    this.logger = opts.logger ?? silentLogger
    this.keepAliveMs = opts.keepAliveMs ?? 30 * 60_000
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000
    this.staleAfterMs = opts.staleAfterMs ?? 10 * 60_000
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000
  }

  get connected(): boolean {
    return this.currentStatus === 'connected'
  }

  on<K extends keyof UserDataStreamEvents>(event: K, handler: UserDataStreamEvents[K]): () => void {
    const set = this.listeners[event] as Set<UserDataStreamEvents[K]>
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.run++
    this.attempts = 0
    this.resyncPending = false
    void this.connect(this.run)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.run++
    this.clearTimers()
    this.detach()
    this.setStatus('closed')
    if (this.listenKey === null) return
    this.listenKey = null
    await this.closeListenKey()
  }

  private async closeListenKey(): Promise<void> {
    try {
      await this.trade.listenKeyClose()
    } catch (err) {
      this.logger.warn({ reason: classifyBinanceError(err).message }, 'UserDataStream: no se pudo cerrar el listenKey (vence solo a los 60 min)')
    }
  }

  // ---------- conexión ----------

  private async connect(run: number): Promise<void> {
    let listenKey: string
    try {
      listenKey = await this.trade.listenKeyCreate()
    } catch (err) {
      if (run !== this.run) return
      this.logger.warn({ reason: classifyBinanceError(err).message }, 'UserDataStream: no se pudo crear el listenKey')
      this.scheduleReconnect()
      return
    }
    if (run !== this.run) {
      // Paró mientras lo pedía: nadie lo va a usar. Si ya volvió a arrancar, no se cierra:
      // Binance da un listenKey por cuenta y la vuelta nueva recibe el mismo.
      if (this.stopped) await this.closeListenKey()
      return
    }
    this.listenKey = listenKey
    const socket = new this.SocketImpl(`${this.base}/${encodeURIComponent(listenKey)}`, { handshakeTimeout: this.handshakeTimeoutMs })
    const link: Link = { socket, listenKey }
    this.link = link
    socket.on('open', () => this.onOpen(link))
    socket.on('message', (raw) => {
      if (link !== this.link) return
      this.touch()
      this.handleMessage(link, raw)
    })
    socket.on('ping', () => {
      if (link === this.link) this.touch()
    })
    socket.on('error', (err) => {
      if (link === this.link) this.logger.warn({ err: err.message }, 'UserDataStream: error de conexión')
    })
    socket.on('close', (code) => this.onClose(link, code))
  }

  private onOpen(link: Link): void {
    if (link !== this.link) return
    this.attempts = 0
    this.setStatus('connected')
    this.touch()
    this.armKeepAlive(this.keepAliveMs)
    if (!this.resyncPending) return
    this.resyncPending = false
    this.emit('resync')
  }

  private onClose(link: Link, code: number): void {
    if (link !== this.link) return
    this.link = null
    this.clearTimers()
    if (this.stopped) return
    this.logger.warn({ code }, 'UserDataStream: conexión cerrada, reconectando')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.resyncPending = true
    this.setStatus('reconnecting')
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempts)
    this.attempts++
    const run = this.run
    this.clock.timers.clearTimeout(this.timers.backoff)
    this.timers.backoff = this.clock.timers.setTimeout(() => void this.connect(run), delay)
  }

  // El listenKey ya no sirve: se suelta la conexión y se pide otro en el acto.
  private restart(): void {
    this.clearTimers()
    this.detach()
    this.resyncPending = true
    this.setStatus('reconnecting')
    void this.connect(this.run)
  }

  private detach(): void {
    const link = this.link
    this.link = null
    if (link) closeSocket(link.socket)
  }

  // ---------- renovación y vigía ----------

  private armKeepAlive(ms: number): void {
    this.clock.timers.clearTimeout(this.timers.keepAlive)
    const link = this.link
    this.timers.keepAlive = this.clock.timers.setTimeout(() => void this.keepAlive(link), ms)
  }

  private async keepAlive(link: Link | null): Promise<void> {
    if (link === null || link !== this.link) return
    try {
      await this.trade.listenKeyKeepAlive()
    } catch (err) {
      if (link !== this.link) return
      if (err instanceof BinanceHttpError && err.code === LISTEN_KEY_MISSING) {
        this.logger.warn('UserDataStream: Binance ya no tiene el listenKey; se crea otro')
        this.restart()
        return
      }
      this.logger.warn({ reason: classifyBinanceError(err).message, retryInMs: this.backoffMaxMs }, 'UserDataStream: no se pudo renovar el listenKey')
      this.armKeepAlive(this.backoffMaxMs)
      return
    }
    if (link === this.link) this.armKeepAlive(this.keepAliveMs)
  }

  private touch(): void {
    this.clock.timers.clearTimeout(this.timers.stale)
    const link = this.link
    this.timers.stale = this.clock.timers.setTimeout(() => {
      if (link === null || link !== this.link) return
      this.logger.warn({ staleAfterMs: this.staleAfterMs }, 'UserDataStream: sin pings ni mensajes, se reinicia la conexión')
      link.socket.terminate()
    }, this.staleAfterMs)
  }

  private clearTimers(): void {
    this.clock.timers.clearTimeout(this.timers.keepAlive)
    this.clock.timers.clearTimeout(this.timers.stale)
    this.clock.timers.clearTimeout(this.timers.backoff)
    this.timers = {}
  }

  // ---------- mensajes ----------

  private handleMessage(link: Link, raw: RawData): void {
    let message: unknown
    try {
      message = JSON.parse(rawToString(raw))
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'UserDataStream: mensaje ilegible, se ignora')
      return
    }
    let event: UserEvent | null
    try {
      event = parseUserEvent(message)
    } catch (err) {
      // `parseUserEvent` sólo tira con un evento que se usa: lo que traía hay que pedirlo por REST.
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'UserDataStream: evento de la cuenta mal formado; se pide resync')
      this.emit('resync')
      return
    }
    if (event === null) return
    switch (event.kind) {
      case 'order':
        this.emit('order', event.update)
        return
      case 'algo':
        this.emit('algo', event.update)
        return
      case 'account':
        this.emit('account', event.update)
        return
      case 'expired':
        if (event.listenKey !== link.listenKey) return
        this.logger.warn('UserDataStream: venció el listenKey; se crea otro')
        this.restart()
    }
  }

  private setStatus(status: UserStreamStatus): void {
    if (status === this.currentStatus) return
    this.currentStatus = status
    this.emit('status', status)
  }

  private emit<K extends keyof UserDataStreamEvents>(event: K, ...args: Parameters<UserDataStreamEvents[K]>): void {
    for (const handler of this.listeners[event]) {
      try {
        ;(handler as (...a: Parameters<UserDataStreamEvents[K]>) => void)(...args)
      } catch (err) {
        // Sólo el nombre del evento: lo que trae puede llevar el listenKey.
        this.logger.error({ err, listener: event }, 'UserDataStream: un handler lanzó una excepción')
      }
    }
  }
}
