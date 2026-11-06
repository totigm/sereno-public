// Una conexión al stream `/market` de Binance USDT-M (spec §3 y §12): velas de 15m/1h/4h
// y precio de marca a 1 s de todos los símbolos del universo. Emite sólo velas cerradas
// (`x = true`), detecta huecos por `openTime` saltado, manda pong proactivo, reconecta
// con backoff, rota la conexión antes de las 24 h en un momento tranquilo y reintenta los
// SUBSCRIBE que Binance rechaza.

import { WebSocket, type RawData } from 'ws'
import type { Candle, MarkTick, Timeframe } from '@sereno/core'
import type { Logger } from 'pino'
import { silentLogger } from '../logger'
import { ControlLedger, SUBSCRIBE_MAX_RETRIES, SUBSCRIBE_RETRY_BASE_MS, type SentControl } from './control-ledger'
import { nextControlStep } from './subscriptions'
import { INTERVAL_MS, TIMEFRAMES, isObject, isTimeframe, type KlineEvent, type MarkPriceEvent, type MarketStreamName, type StreamControlMessage } from './types'

export type StreamStatus = 'connected' | 'reconnecting' | 'closed'

// Velas que faltaron entre la última vista y la recibida: `from`..`to` son `openTime`
// inclusivos, listos para pedir por REST (`klines` con `startTime`/`endTime`).
export interface Gap {
  symbol: string
  tf: Timeframe
  from: number
  to: number
}

export interface MarketStreamEvents {
  kline: (symbol: string, tf: Timeframe, candle: Candle) => void
  mark: (tick: MarkTick) => void
  gap: (gap: Gap) => void
  status: (status: StreamStatus) => void
  // Símbolos cuyo SUBSCRIBE Binance rechazó también en el último reintento: siguen en
  // `symbols` pero no llegan datos. El runtime decide (marcarlos degradados, darlos de baja).
  subscription_failed: (symbols: string[]) => void
}

// Lo único que el stream usa de un socket: `ws` lo cumple y los tests usan uno falso.
export interface StreamSocket {
  readonly readyState: number
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: RawData) => void): this
  on(event: 'ping', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
  removeAllListeners(event: 'message'): this
  send(data: string): void
  pong(): void
  close(code?: number, reason?: string): void
  terminate(): void
}

export interface StreamSocketOptions {
  handshakeTimeout: number
}

export type StreamSocketFactory = new (url: string, options: StreamSocketOptions) => StreamSocket

export interface MarketStreamOptions {
  symbols: string[]
  url?: string
  streams?: readonly MarketStreamName[]
  WebSocket?: StreamSocketFactory
  now?: () => number
  logger?: Logger
  // Pong no solicitado cada tanto: Binance corta si no hay pong en 10 min tras su ping (cada 3).
  pingIntervalMs?: number
  // Sin ningún mensaje en este lapso (markPrice@1s llega cada segundo) se da por muerta la conexión.
  staleAfterMs?: number
  // Rotación programada: Binance corta a las 24 h, rotamos antes y en un momento tranquilo.
  reconnectAfterMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  // Espaciado entre mensajes SUBSCRIBE/UNSUBSCRIBE: como mínimo MIN_CONTROL_INTERVAL_MS.
  subscribeIntervalMs?: number
  // Espera antes del primer reintento de un SUBSCRIBE rechazado; se duplica en cada uno.
  subscribeRetryBaseMs?: number
  // Tope para el handshake HTTP→WS; si vence, ws cierra y entra el backoff.
  handshakeTimeoutMs?: number
}

export const BINANCE_MARKET_STREAM_URL = 'wss://fstream.binance.com/market/stream'
export const DEFAULT_MARKET_STREAMS = ['kline_15m', 'kline_1h', 'kline_4h', 'markPrice@1s'] as const satisfies readonly MarketStreamName[]
export const MAX_STREAMS_PER_CONNECTION = 1024
// Binance corta la conexión pasados 10 mensajes entrantes por segundo (pings y pongs
// incluidos); la spec fija ≤ 5 de control por segundo para dejar lugar a los pongs.
export const MIN_CONTROL_INTERVAL_MS = 200

const MIN15 = INTERVAL_MS['15m']
const QUIET_MARGIN_MS = 10_000
const HOUR = 3_600_000

export function streamNames(symbols: readonly string[], streams: readonly MarketStreamName[]): string[] {
  return symbols.flatMap((symbol) => streams.map((stream) => `${symbol.toLowerCase()}@${stream}`))
}

// Las rutas legadas `/ws` y `/stream` fueron decomisionadas el 2026-04-23: sólo `/market/`.
export function assertMarketRoute(url: string): void {
  if (!url.includes('/market/')) throw new Error(`MarketStream: la URL "${url}" no es la ruta /market/ de Binance (las rutas /ws y /stream fueron decomisionadas)`)
}

export function buildStreamUrl(base: string, symbols: readonly string[], streams: readonly MarketStreamName[]): string {
  assertMarketRoute(base)
  const names = streamNames(symbols, streams)
  if (names.length === 0) throw new Error('MarketStream: hace falta al menos un símbolo y un stream')
  if (names.length > MAX_STREAMS_PER_CONNECTION) {
    throw new Error(`MarketStream: ${names.length} streams superan el máximo de ${MAX_STREAMS_PER_CONNECTION} por conexión`)
  }
  return `${base}?streams=${names.join('/')}`
}

// Corre `t` fuera de los 10 s que rodean el cierre de una vela de 15m (el bot decide ahí).
export function quietReconnectTime(t: number): number {
  const offset = t % MIN15
  if (offset < QUIET_MARGIN_MS) return t - offset + QUIET_MARGIN_MS
  if (offset >= MIN15 - QUIET_MARGIN_MS) return t - offset + MIN15 + QUIET_MARGIN_MS
  return t
}

type Listeners = { [K in keyof MarketStreamEvents]: Set<MarketStreamEvents[K]> }
type Timer = ReturnType<typeof setTimeout>

// Un socket y lo que el servidor tiene suscripto en él: los símbolos de su URL más los
// SUBSCRIBE/UNSUBSCRIBE ya mandados (un SUBSCRIBE rechazado sigue contando, para que el
// outbox no lo repita a cada paso: lo reintenta `control`). El límite de mensajes es por conexión.
interface Link {
  socket: StreamSocket
  symbols: Set<string>
  lastSentAt: number
  control: ControlLedger
}

export class MarketStream {
  private readonly base: string
  private readonly streams: readonly MarketStreamName[]
  // Conjunto deseado: lo que piden `subscribe`/`unsubscribe`, haya conexión abierta o no.
  private readonly symbolSet = new Set<string>()
  private readonly SocketImpl: StreamSocketFactory
  private readonly now: () => number
  private readonly logger: Logger
  private readonly pingIntervalMs: number
  private readonly staleAfterMs: number
  private readonly reconnectAfterMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly subscribeIntervalMs: number
  private readonly subscribeRetryBaseMs: number
  private readonly handshakeTimeoutMs: number

  private readonly listeners: Listeners = { kline: new Set(), mark: new Set(), gap: new Set(), status: new Set(), subscription_failed: new Set() }
  // La conexión que entrega datos, y la que se está abriendo para reemplazarla en una rotación.
  private active: Link | null = null
  private standby: Link | null = null
  private stopped = true
  private attempts = 0
  private currentStatus: StreamStatus = 'closed'
  private timers: { ping?: Timer | undefined; stale?: Timer | undefined; backoff?: Timer | undefined; planned?: Timer | undefined; outbox?: Timer | undefined } = {}
  private planned: number | null = null
  // Última vela cerrada vista por símbolo y marco: base de la detección de huecos.
  private readonly lastClosedOpen = new Map<string, number>()
  private readonly lastPrice = new Map<string, number>()
  private nextMessageId = 1

  constructor(opts: MarketStreamOptions) {
    this.base = opts.url ?? BINANCE_MARKET_STREAM_URL
    assertMarketRoute(this.base)
    this.streams = opts.streams ?? DEFAULT_MARKET_STREAMS
    for (const s of opts.symbols) this.symbolSet.add(s.toUpperCase())
    this.SocketImpl = opts.WebSocket ?? WebSocket
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? silentLogger
    this.pingIntervalMs = opts.pingIntervalMs ?? 2 * 60_000
    this.staleAfterMs = opts.staleAfterMs ?? 60_000
    this.reconnectAfterMs = opts.reconnectAfterMs ?? 23 * HOUR
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000
    this.subscribeIntervalMs = opts.subscribeIntervalMs ?? MIN_CONTROL_INTERVAL_MS
    if (this.subscribeIntervalMs < MIN_CONTROL_INTERVAL_MS) {
      throw new RangeError(`MarketStream: subscribeIntervalMs ${this.subscribeIntervalMs} es menor que ${MIN_CONTROL_INTERVAL_MS} ms`)
    }
    this.subscribeRetryBaseMs = opts.subscribeRetryBaseMs ?? SUBSCRIBE_RETRY_BASE_MS
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000
    // Valida cantidad de streams desde el arranque.
    buildStreamUrl(this.base, this.symbols, this.streams)
  }

  get url(): string {
    return buildStreamUrl(this.base, this.symbols, this.streams)
  }

  get symbols(): string[] {
    return [...this.symbolSet]
  }

  get status(): StreamStatus {
    return this.currentStatus
  }

  get plannedReconnectAt(): number | null {
    return this.planned
  }

  on<K extends keyof MarketStreamEvents>(event: K, handler: MarketStreamEvents[K]): () => void {
    const set = this.listeners[event] as Set<MarketStreamEvents[K]>
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempts = 0
    this.scheduleReconnectAt(this.now() + this.reconnectAfterMs)
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.planned = null
    const links = [this.active, this.standby]
    this.active = null
    this.standby = null
    for (const link of links) if (link) closeLink(link)
    this.setStatus('closed')
  }

  // Rota la conexión en `t` (corrido a un momento tranquilo); reemplaza la rotación anterior.
  scheduleReconnectAt(t: number): void {
    const at = quietReconnectTime(t)
    this.planned = at
    clearTimeout(this.timers.planned)
    this.timers.planned = setTimeout(() => this.rotate(), Math.max(0, at - this.now()))
    this.timers.planned.unref?.()
  }

  // Altas y bajas valen en el acto para los eventos; al servidor le llegan apenas haya
  // una conexión abierta, al ritmo permitido (ver `subscriptions.ts`).
  subscribe(symbols: readonly string[]): void {
    const added = symbols.map((s) => s.toUpperCase()).filter((s) => !this.symbolSet.has(s))
    if (added.length === 0) return
    if (streamNames([...this.symbolSet, ...added], this.streams).length > MAX_STREAMS_PER_CONNECTION) {
      throw new Error(`MarketStream: suscribir ${added.join(', ')} superaría los ${MAX_STREAMS_PER_CONNECTION} streams por conexión`)
    }
    for (const s of added) this.symbolSet.add(s)
    this.flushOutbox()
  }

  unsubscribe(symbols: readonly string[]): void {
    const removed = symbols.map((s) => s.toUpperCase()).filter((s) => this.symbolSet.has(s))
    if (removed.length === 0) return
    if (removed.length === this.symbolSet.size) throw new Error('MarketStream: no se puede quitar el último símbolo; usá stop()')
    for (const s of removed) {
      this.symbolSet.delete(s)
      // Sin esto, volver a pedirlo días después emitiría un hueco gigante desde la última vela vista.
      for (const tf of TIMEFRAMES) this.lastClosedOpen.delete(`${s}:${tf}`)
      this.lastPrice.delete(s)
    }
    this.flushOutbox()
  }

  // ---------- conexión ----------

  private connect(): void {
    if (this.stopped) return
    this.active = this.openLink()
  }

  // La URL lleva el conjunto deseado de este momento; lo que cambie durante el handshake
  // se manda al abrir.
  private openLink(): Link {
    const symbols = new Set(this.symbolSet)
    const socket = new this.SocketImpl(buildStreamUrl(this.base, [...symbols], this.streams), { handshakeTimeout: this.handshakeTimeoutMs })
    const control = new ControlLedger({
      retryBaseMs: this.subscribeRetryBaseMs,
      maxRetries: SUBSCRIBE_MAX_RETRIES,
      onRetryReady: () => {
        if (link === this.active) this.flushOutbox()
      },
    })
    const link: Link = { socket, symbols, lastSentAt: -Infinity, control }
    socket.on('open', () => this.onOpen(link))
    socket.on('message', (raw) => {
      if (link !== this.active) return
      this.touch()
      this.handleMessage(link, raw)
    })
    // El ping del servidor (cada 3 min) también cuenta como señal de vida; ws responde el pong solo.
    socket.on('ping', () => {
      if (link === this.active) this.touch()
    })
    socket.on('error', (err) => {
      if (link !== this.active && link !== this.standby) return
      this.logger.warn({ err: err.message, standby: link === this.standby }, 'MarketStream: error de conexión')
    })
    socket.on('close', (code, reason) => this.onClose(link, code, reason.toString()))
    return link
  }

  private onOpen(link: Link): void {
    if (link === this.standby) {
      // Rotación: recién con la conexión nueva abierta se suelta la vieja; no hay hueco.
      const old = this.active
      this.active = link
      this.standby = null
      if (old) closeLink(old)
      this.logger.info('MarketStream: rotación completada')
    } else if (link !== this.active) {
      return
    }
    this.attempts = 0
    this.setStatus('connected')
    this.armPing()
    this.touch()
    this.flushOutbox()
  }

  private onClose(link: Link, code: number, reason: string): void {
    if (link === this.standby) {
      this.standby = null
      if (this.stopped) return
      this.logger.warn({ code, reason, retryInMs: this.backoffMaxMs }, 'MarketStream: la conexión de rotación no abrió; sigue la actual')
      this.scheduleReconnectAt(this.now() + this.backoffMaxMs)
      return
    }
    if (link !== this.active) return
    this.active = null
    link.control.dispose()
    clearInterval(this.timers.ping)
    clearTimeout(this.timers.stale)
    clearTimeout(this.timers.outbox)
    this.timers.outbox = undefined
    if (this.stopped) return
    this.setStatus('reconnecting')
    if (this.standby) {
      // Se cayó durante una rotación: la conexión que ya se está abriendo toma su lugar.
      this.active = this.standby
      this.standby = null
      this.logger.warn({ code, reason }, 'MarketStream: conexión cerrada durante la rotación; sigue la nueva')
      return
    }
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempts)
    this.attempts++
    this.logger.warn({ code, reason, attempt: this.attempts, delayMs: delay }, 'MarketStream: conexión cerrada, reconectando')
    clearTimeout(this.timers.backoff)
    this.timers.backoff = setTimeout(() => this.connect(), delay)
  }

  // Rotación programada: abre la conexión nueva y suelta la vieja recién cuando la nueva
  // abre. Sin conexión abierta no hay nada que rotar: el backoff o el handshake en curso
  // ya traen el conjunto vigente.
  private rotate(): void {
    if (this.stopped) return
    this.scheduleReconnectAt(this.now() + this.reconnectAfterMs)
    if (!this.active || this.active.socket.readyState !== WebSocket.OPEN || this.standby) return
    this.logger.info('MarketStream: rotación programada de la conexión')
    this.standby = this.openLink()
  }

  private armPing(): void {
    clearInterval(this.timers.ping)
    this.timers.ping = setInterval(() => {
      const socket = this.active?.socket
      if (socket && socket.readyState === WebSocket.OPEN) socket.pong()
    }, this.pingIntervalMs)
    this.timers.ping.unref?.()
  }

  // Reinicia el vigía de silencio: si no entra nada en `staleAfterMs`, se corta y reconecta.
  private touch(): void {
    clearTimeout(this.timers.stale)
    this.timers.stale = setTimeout(() => {
      const socket = this.active?.socket
      if (!socket) return
      this.logger.warn({ staleAfterMs: this.staleAfterMs }, 'MarketStream: sin mensajes, se reinicia la conexión')
      socket.terminate()
    }, this.staleAfterMs)
    this.timers.stale.unref?.()
  }

  private clearTimers(): void {
    clearInterval(this.timers.ping)
    clearTimeout(this.timers.stale)
    clearTimeout(this.timers.backoff)
    clearTimeout(this.timers.planned)
    clearTimeout(this.timers.outbox)
    this.timers = {}
  }

  // ---------- SUBSCRIBE / UNSUBSCRIBE ----------

  // Manda a la conexión activa lo que le falta para llegar al conjunto deseado, de a un
  // mensaje por `subscribeIntervalMs`; los reintentos listos van primero, con los símbolos
  // del lote que siguen pedidos. Sin conexión abierta no hace nada: al abrir se vuelve a
  // llamar, y una conexión nueva ya nace con el conjunto en la URL.
  private flushOutbox(): void {
    if (this.timers.outbox) return
    const link = this.active
    if (!link || link.socket.readyState !== WebSocket.OPEN) return
    const retry = link.control.nextRetry((s) => this.symbolSet.has(s) && link.symbols.has(s))
    const step = retry ?? nextControlStep(this.symbolSet, link.symbols)
    if (!step) return
    const wait = link.lastSentAt + this.subscribeIntervalMs - this.now()
    if (wait > 0) {
      this.timers.outbox = setTimeout(() => {
        this.timers.outbox = undefined
        this.flushOutbox()
      }, wait)
      this.timers.outbox.unref?.()
      return
    }
    const message: StreamControlMessage = { method: step.method, params: streamNames(step.symbols, this.streams), id: this.nextMessageId++ }
    if (retry) link.control.dropRetry()
    if (step.method === 'SUBSCRIBE') link.control.supersede(step.symbols)
    for (const s of step.symbols) {
      if (step.method === 'SUBSCRIBE') link.symbols.add(s)
      else link.symbols.delete(s)
    }
    link.lastSentAt = this.now()
    link.socket.send(JSON.stringify(message))
    link.control.sent(message.id, { method: step.method, symbols: step.symbols, retries: retry?.retries ?? 0 })
    this.logger.debug({ id: message.id, method: message.method, symbols: step.symbols, retries: retry?.retries ?? 0 }, 'MarketStream: mensaje de control enviado')
    this.flushOutbox()
  }

  private onControlAnswer(link: Link, id: number, error: unknown): void {
    const rejected = error !== undefined && error !== null
    const answer = link.control.answer(id, rejected)
    switch (answer.kind) {
      case 'accepted':
      case 'superseded':
        return
      case 'unknown':
        if (rejected) this.logger.warn({ id, error }, 'MarketStream: Binance rechazó un mensaje de control desconocido')
        return
      case 'unsubscribe_rejected':
        this.logger.warn({ id, error, symbols: answer.control.symbols }, 'MarketStream: Binance rechazó un UNSUBSCRIBE')
        return
      case 'retrying':
        this.logger.warn({ id, error, symbols: answer.control.symbols, retryInMs: answer.delayMs }, 'MarketStream: Binance rechazó un SUBSCRIBE, se reintenta')
        return
      case 'failed':
        this.onSubscriptionFailed(answer.control, error)
    }
  }

  // Sólo se avisan los símbolos que siguen pedidos: uno dado de baja ya no importa.
  private onSubscriptionFailed(control: SentControl, error: unknown): void {
    const symbols = control.symbols.filter((s) => this.symbolSet.has(s))
    this.logger.error({ error, symbols, retries: control.retries }, 'MarketStream: Binance rechazó el SUBSCRIBE en todos los reintentos')
    if (symbols.length > 0) this.emit('subscription_failed', symbols)
  }

  // ---------- mensajes ----------

  private handleMessage(link: Link, raw: RawData): void {
    let message: unknown
    try {
      message = JSON.parse(rawToString(raw))
    } catch {
      this.logger.warn('MarketStream: mensaje no JSON')
      return
    }
    if (!isObject(message)) return
    if ('stream' in message && isObject(message.data)) {
      const data = message.data
      if (data.e === 'kline') this.onKline(data as unknown as KlineEvent)
      else if (data.e === 'markPriceUpdate') this.onMark(data as unknown as MarkPriceEvent)
      return
    }
    // Respuesta a un mensaje de control: `{ result: null, id }` o `{ error, id }`.
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      this.onControlAnswer(link, message.id, 'error' in message ? message.error : undefined)
    } else if ('error' in message) {
      this.logger.warn({ id: message.id, error: message.error }, 'MarketStream: Binance respondió con error')
    }
  }

  private onKline(event: KlineEvent): void {
    const k = event.k
    const symbol = k.s.toUpperCase()
    const tf = k.i
    // Lo que Binance siga mandando de un símbolo dado de baja (antes de procesar el
    // UNSUBSCRIBE) no le llega al runtime.
    if (!isTimeframe(tf) || !this.symbolSet.has(symbol)) return
    const close = Number(k.c)
    if (Number.isFinite(close)) this.lastPrice.set(symbol, close)
    if (!k.x) return

    const key = `${symbol}:${tf}`
    const ms = INTERVAL_MS[tf]
    const last = this.lastClosedOpen.get(key)
    if (last !== undefined && k.t <= last) return
    if (last !== undefined && k.t > last + ms) this.emit('gap', { symbol, tf, from: last + ms, to: k.t - ms })
    this.lastClosedOpen.set(key, k.t)
    this.emit('kline', symbol, tf, {
      openTime: k.t,
      closeTime: k.t + ms - 1,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close,
      volume: Number(k.v),
      quoteVolume: Number(k.q),
      closed: true,
    })
  }

  private onMark(event: MarkPriceEvent): void {
    const symbol = event.s.toUpperCase()
    if (!this.symbolSet.has(symbol)) return
    const markPrice = Number(event.p)
    if (!Number.isFinite(markPrice)) return
    const rate = event.r === '' || event.r === undefined ? NaN : Number(event.r)
    this.emit('mark', {
      symbol,
      markPrice,
      lastPrice: this.lastPrice.get(symbol) ?? markPrice,
      at: event.E,
      fundingRate: Number.isFinite(rate) ? rate : null,
      nextFundingTime: event.T > 0 ? event.T : null,
    })
  }

  private setStatus(status: StreamStatus): void {
    if (status === this.currentStatus) return
    this.currentStatus = status
    this.emit('status', status)
  }

  private emit<K extends keyof MarketStreamEvents>(event: K, ...args: Parameters<MarketStreamEvents[K]>): void {
    for (const handler of this.listeners[event]) {
      try {
        ;(handler as (...a: Parameters<MarketStreamEvents[K]>) => void)(...args)
      } catch (err) {
        this.logger.error({ err, event }, 'MarketStream: un handler lanzó una excepción')
      }
    }
  }
}

function closeLink(link: Link): void {
  link.control.dispose()
  closeSocket(link.socket)
}

// Suelta un socket sin escuchar más nada de él (ni sus errores al cerrarse).
export function closeSocket(socket: StreamSocket): void {
  socket.removeAllListeners('message')
  socket.on('error', () => {})
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
  else socket.close(1000, 'sereno: cierre')
}

export function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  return Buffer.from(raw as ArrayBuffer).toString('utf8')
}
