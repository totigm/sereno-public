// Binance falso para tests de integración del bot: REST `fapi` sobre `node:http` y el
// stream `/market/stream` sobre `ws`. Sirve los fixtures, deja guionar fallos (451, 429,
// 5xx…) por ruta, registra cada pedido y permite empujar eventos a los clientes
// conectados o cortarlos para simular caídas. Atiende también los dos pedidos firmados
// de la clave de sólo lectura (`fake/account.ts`), con un modo "clave rechazada"
// (-2015), y la cuenta que opera (`trading`: órdenes, algorítmicas, posiciones, listenKey
// y `/sapi/v1/account/apiRestrictions`, apagable con `sapiEnabled` para simular testnet).
// La firma se verifica en GET, POST, PUT y DELETE. Acepta upgrades en `/market/` y en la
// ruta privada del user data stream (`/private/ws/<listenKey>`, `fake/user-stream.ts`): las
// rutas legadas `/ws` y `/stream` responden 404, como Binance desde 2026-04-23.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { klinesWeight } from '../rest'
import { isObject, type KlineInterval } from '../types'
import { KEY_REJECTED_ERROR } from './account-fixtures'
import { answerSigned, defaultAccount, SIGNED_PATHS, type FakeAccount } from './account'
import * as fx from './fixtures'
import { FakeTrading } from './trading'
import { answerTrading } from './trading-routes'
import { FakeUserStream, USER_STREAM_PATH, type UserConnection } from './user-stream'

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  // El query tal cual llegó (para verificar una firma).
  rawQuery: string
  // El header `X-MBX-APIKEY`, si vino.
  apiKey: string | null
  at: number
}

export interface ScriptedResponse {
  // Sólo la consume un pedido con este método (por defecto, cualquiera).
  method?: string
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface WsConnection {
  path: string
  streams: string[]
  socket: WebSocket
  openedAt: number
}

export interface WsMessage {
  at: number
  message: unknown
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export class FakeBinance {
  readonly baseUrl: string
  readonly wsUrl: string
  // La ruta privada del user data stream, sin el listenKey.
  readonly userWsUrl: string
  requests: RecordedRequest[] = []
  wsConnections: WsConnection[] = []
  wsMessages: WsMessage[] = []
  pongs = 0
  // Reloj del servidor: las series generadas llegan hasta acá. Reemplazable por test.
  now: () => number = Date.now
  // La cuenta de los pedidos firmados: clave, secret y modo de error.
  account: FakeAccount = defaultAccount()
  private readonly userStream = new FakeUserStream()
  // La cuenta de futuros que opera; su reloj es `now` más el desfase que se le configure.
  trading: FakeTrading = this.newTrading()
  // `false` simula testnet: no existe `/sapi` (ni el `/api` de su hora).
  sapiEnabled = true

  private readonly scripted = new Map<string, ScriptedResponse[]>()
  private forcedUsedWeight: number | null = null
  private usedWeight = 0
  private usedWeightMinute = -1

  private constructor(
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`
    this.wsUrl = `ws://127.0.0.1:${port}/market/stream`
    this.userWsUrl = `ws://127.0.0.1:${port}/private/ws`
  }

  static async start(): Promise<FakeBinance> {
    const http = createServer()
    const wss = new WebSocketServer({ noServer: true })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as AddressInfo
    const fake = new FakeBinance(http, wss, port)
    http.on('request', (req, res) => fake.handleRequest(req, res))
    http.on('upgrade', (req, socket, head) => fake.handleUpgrade(req, socket, head))
    return fake
  }

  async stop(): Promise<void> {
    this.reset()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  // Vuelve al estado inicial entre tests: borra registros, guiones y corta clientes.
  reset(): void {
    this.requests = []
    this.scripted.clear()
    this.forcedUsedWeight = null
    this.usedWeight = 0
    this.usedWeightMinute = -1
    this.now = Date.now
    this.account = defaultAccount()
    this.trading = this.newTrading()
    this.sapiEnabled = true
    this.wsMessages = []
    this.pongs = 0
    for (const c of this.wsConnections) c.socket.terminate()
    this.wsConnections = []
    this.userStream.reset()
  }

  // Las próximas `times` respuestas de `path` serán `response` en vez de la normal.
  failNext(path: string, response: ScriptedResponse, times = 1): void {
    const queue = this.scripted.get(path) ?? []
    for (let i = 0; i < times; i++) queue.push(response)
    this.scripted.set(path, queue)
  }

  private newTrading(): FakeTrading {
    const trading = new FakeTrading(() => this.now())
    this.userStream.attach(trading)
    return trading
  }

  // Desde ahora todo pedido firmado contesta -2015 (clave inválida, IP o permisos), como
  // una clave sin permiso de lectura de futuros. Dura hasta `reset()`.
  rejectKey(): void {
    this.account = { ...this.account, rejected: { status: 401, ...KEY_REJECTED_ERROR } }
  }

  // Fuerza el valor del header X-MBX-USED-WEIGHT-1M (si no, el falso lleva su propia cuenta).
  setUsedWeight(value: number | null): void {
    this.forcedUsedWeight = value
  }

  // ---------- Stream ----------

  push(stream: string, data: unknown): void {
    const payload = JSON.stringify({ stream, data })
    for (const c of this.wsConnections) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(payload)
    }
  }

  // Corta todos los clientes sin handshake de cierre (como una caída de red).
  dropClients(): void {
    for (const c of this.wsConnections) c.socket.terminate()
  }

  // Pinguea los clientes de los dos streams (Binance lo hace cada 3 min).
  pingClients(): void {
    for (const c of this.wsConnections) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.ping()
    }
    this.userStream.ping()
  }

  // ---------- User data stream ----------

  get userConnections(): readonly UserConnection[] {
    return this.userStream.connections
  }

  get userPongs(): number {
    return this.userStream.pongs
  }

  // Binance avisa `listenKeyExpired` y el listenKey deja de existir.
  expireListenKey(): void {
    this.userStream.expire()
  }

  // Corta los clientes del user data stream sin handshake de cierre.
  dropUserClients(): void {
    this.userStream.drop()
  }

  // Con `true` los eventos de la cuenta se guardan; con `false` salen todos, en orden.
  holdUserEvents(on: boolean): void {
    this.userStream.hold(on)
  }

  async waitForWsConnections(count: number, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.wsConnections.length < count) {
      if (Date.now() > deadline) throw new Error(`FakeBinance: esperaba ${count} conexiones websocket, hay ${this.wsConnections.length}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', this.baseUrl)
    if (url.pathname.startsWith(USER_STREAM_PATH)) {
      this.handleUserUpgrade(url.pathname, req, socket, head)
      return
    }
    if (!url.pathname.startsWith('/market/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const streams = (url.searchParams.get('streams') ?? '').split('/').filter(Boolean)
      const connection: WsConnection = { path: url.pathname, streams, socket: ws, openedAt: Date.now() }
      this.wsConnections.push(connection)
      ws.on('pong', () => {
        this.pongs++
      })
      ws.on('message', (raw) => {
        let message: unknown
        try {
          message = JSON.parse(raw.toString())
        } catch {
          message = raw.toString()
        }
        this.wsMessages.push({ at: Date.now(), message })
        if (isObject(message) && typeof message.id === 'number') {
          const params = Array.isArray(message.params) ? (message.params as string[]) : []
          if (message.method === 'SUBSCRIBE') connection.streams.push(...params)
          if (message.method === 'UNSUBSCRIBE') connection.streams = connection.streams.filter((s) => !params.includes(s))
          ws.send(JSON.stringify({ result: null, id: message.id }))
        }
      })
    })
  }

  private handleUserUpgrade(path: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const listenKey = this.userStream.acceptable(path)
    if (listenKey === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.userStream.add(listenKey, ws))
  }

  // ---------- REST ----------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.baseUrl)
    const query = Object.fromEntries(url.searchParams.entries())
    const rawQuery = url.search.slice(1)
    const header = req.headers['x-mbx-apikey']
    const apiKey = typeof header === 'string' ? header : null
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query, rawQuery, apiKey, at: Date.now() })

    const method = req.method ?? 'GET'
    const scripted = this.takeScripted(url.pathname, method)
    if (scripted) {
      this.send(res, scripted.status, scripted.body ?? { code: -1000, msg: `scripted ${scripted.status}` }, scripted.headers)
      return
    }
    if (SIGNED_PATHS.has(url.pathname)) {
      const answer = answerSigned(this.account, { path: url.pathname, rawQuery, apiKey, now: this.trading.now() })
      this.usedWeight += answer.weight
      this.send(res, answer.status, answer.body)
      return
    }
    const trading = answerTrading(this.trading, this.account, { method, path: url.pathname, query, rawQuery, apiKey }, { sapiEnabled: this.sapiEnabled })
    if (trading) {
      this.usedWeight += trading.weight
      // La orden ya entró; la respuesta se corta antes de llegar (como una caída de red).
      if (method !== 'GET' && trading.status === 200 && this.trading.takeDrop(url.pathname)) {
        req.socket.destroy()
        return
      }
      this.send(res, trading.status, trading.body)
      return
    }
    try {
      const body = this.route(url.pathname, query)
      if (body === undefined) {
        this.send(res, 404, { code: -1, msg: `FakeBinance: ruta desconocida ${url.pathname}` })
        return
      }
      this.send(res, 200, body)
    } catch (err) {
      this.send(res, 400, { code: -1100, msg: err instanceof Error ? err.message : String(err) })
    }
  }

  private takeScripted(path: string, method: string): ScriptedResponse | undefined {
    const queue = this.scripted.get(path)
    const at = queue?.findIndex((r) => r.method === undefined || r.method === method) ?? -1
    return at < 0 ? undefined : queue!.splice(at, 1)[0]
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...JSON_HEADERS, 'X-MBX-USED-WEIGHT-1M': String(this.usedWeightHeader()), ...headers })
    res.end(JSON.stringify(body))
  }

  private usedWeightHeader(): number {
    if (this.forcedUsedWeight !== null) return this.forcedUsedWeight
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== this.usedWeightMinute) {
      this.usedWeightMinute = minute
      this.usedWeight = 0
    }
    return this.usedWeight
  }

  private route(path: string, q: Record<string, string>): unknown {
    const now = this.now()
    const limit = q.limit !== undefined ? Number(q.limit) : undefined
    const startTime = q.startTime !== undefined ? Number(q.startTime) : undefined
    const endTime = q.endTime !== undefined ? Number(q.endTime) : undefined
    switch (path) {
      case '/fapi/v1/ping':
        this.usedWeight += 1
        return {}
      case '/fapi/v1/time':
        this.usedWeight += 1
        return { serverTime: this.trading.now() }
      case '/api/v3/time':
        if (!this.sapiEnabled) return undefined
        this.usedWeight += 1
        return { serverTime: this.trading.now() }
      case '/fapi/v1/exchangeInfo':
        this.usedWeight += 1
        return fx.EXCHANGE_INFO
      case '/fapi/v1/klines':
      case '/fapi/v1/markPriceKlines': {
        this.usedWeight += klinesWeight(limit ?? 500)
        const symbol = required(q, 'symbol')
        const interval = required(q, 'interval') as KlineInterval
        return fx.klineRows({ symbol, interval, startTime, endTime, limit, now, mark: path.endsWith('markPriceKlines') })
      }
      case '/fapi/v1/ticker/24hr': {
        const all = fx.ticker24h(now)
        if (q.symbol) {
          this.usedWeight += 1
          return all.find((t) => t.symbol === q.symbol) ?? invalidSymbol()
        }
        this.usedWeight += 40
        return all
      }
      case '/fapi/v1/premiumIndex': {
        const all = fx.premiumIndex(now)
        if (q.symbol) {
          this.usedWeight += 1
          return all.find((p) => p.symbol === q.symbol) ?? invalidSymbol()
        }
        this.usedWeight += 10
        return all
      }
      case '/fapi/v1/ticker/bookTicker': {
        this.usedWeight += q.symbol ? 2 : 5
        if (q.symbol) return fx.bookTicker(q.symbol, now)
        return fx.PERPETUAL_SYMBOLS.map((s) => fx.bookTicker(s, now))
      }
      case '/fapi/v1/fundingRate':
        return fx.fundingRateRows({ symbol: required(q, 'symbol'), startTime, endTime, limit, now })
      case '/fapi/v1/fundingInfo':
        return fx.FUNDING_INFO
      case '/futures/data/openInterestHist':
        return fx.openInterestRows(required(q, 'symbol'), limit ?? 30, now, { startTime, endTime })
      case '/futures/data/globalLongShortAccountRatio':
        return fx.longShortRows(required(q, 'symbol'), limit ?? 30, now, { startTime, endTime })
      case '/futures/data/takerlongshortRatio':
        required(q, 'symbol')
        return fx.takerRows(limit ?? 30, now, { startTime, endTime })
      default:
        return undefined
    }
  }
}

function required(q: Record<string, string>, key: string): string {
  const value = q[key]
  if (!value) throw new Error(`Mandatory parameter '${key}' was not sent, was empty/null, or malformed.`)
  return value
}

function invalidSymbol(): never {
  throw new Error('Invalid symbol.')
}
