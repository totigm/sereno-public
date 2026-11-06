// Transporte HTTP de Binance, común a los datos de mercado (`BinanceRest`), a las órdenes
// (`BinanceTradeRest`) y a `/sapi`. Todo pedido pasa por el limitador, informa el header
// `X-MBX-USED-WEIGHT-1M`, tipa los errores (451 = IP bloqueada) y, con clave, firma con
// HMAC (`signing.ts`): los parámetros viajan en el query, la firma al final.
//
// Reintentos: con `retry: 'safe'` (el de siempre, para lo que se puede repetir sin efecto)
// reintenta con backoff en 429/418/5xx/red. Con `retry: 'never'` (crear órdenes) no reintenta
// nada de eso: devuelve el error a quien decide, que sabe si la orden pudo haber entrado.
// La única excepción en los dos modos es el −1021 (timestamp fuera de la ventana): Binance
// lo rechaza en la puerta sin ejecutar nada, así que se renueva el desfase y se reintenta una vez.

import type { Logger } from 'pino'
import { silentLogger } from '../logger'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from './errors'
import type { LimitKind, Priority, RateLimiter } from './rate-limiter'
import { RECV_WINDOW_MS, redactSignature, signQuery } from './signing'
import type { RawBinanceError, RawServerTime } from './types'

export interface BinanceHttpOptions {
  limiter: RateLimiter
  baseUrl?: string
  fetch?: typeof fetch
  apiKey?: string | null
  // Sólo firma: nunca viaja ni se loguea.
  apiSecret?: string | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  // Tope por pedido (encabezados y cuerpo). Sin él, un Binance trabado sólo lo cortan los
  // timeouts de undici (~5 min cada uno); vencido, cuenta como fallo de red.
  requestTimeoutMs?: number
  // Dónde medir la hora del servidor: `/fapi/v1/time` en futuros, `/api/v3/time` en `/sapi`.
  timePath?: string
  logger?: Logger
}

export type Params = Record<string, string | number | boolean | undefined>
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface Cost {
  kind: LimitKind
  weight: number
}

export interface RequestOptions {
  signed?: boolean
  method?: HttpMethod
  retry?: 'safe' | 'never'
  priority?: Priority
}

export class BinanceHttp {
  private readonly limiter: RateLimiter
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly apiKey: string | null
  private readonly apiSecret: string | null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly requestTimeoutMs: number
  private readonly timePath: string
  private readonly logger: Logger
  // Reloj de Binance − el nuestro, para el `timestamp` de los pedidos firmados: se mide
  // con el primero y se renueva si Binance contesta -1021.
  private timeOffset: number | null = null
  private syncing: Promise<void> | null = null

  constructor(opts: BinanceHttpOptions) {
    this.limiter = opts.limiter
    this.baseUrl = (opts.baseUrl ?? 'https://fapi.binance.com').replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.apiKey = opts.apiKey ?? null
    this.apiSecret = opts.apiSecret ?? null
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.maxRetries = opts.maxRetries ?? 5
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    this.timePath = opts.timePath ?? '/fapi/v1/time'
    this.logger = opts.logger ?? silentLogger
  }

  // Hay clave completa (key y secret) para los pedidos firmados.
  hasKey(): boolean {
    return this.apiKey !== null && this.apiSecret !== null
  }

  async request<T>(path: string, params: Params, cost: Cost, opts: RequestOptions = {}): Promise<T> {
    const { signed = false, method = 'GET', retry = 'safe', priority = 'normal' } = opts
    const secret = signed ? this.requireSecret() : null
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey
    if (signed && this.timeOffset === null) await this.syncTime(priority)
    const retries = retry === 'safe' ? this.maxRetries : 0
    let resynced = false

    for (let attempt = 0; ; attempt++) {
      await this.acquire(cost, priority)
      // Se sella y se firma en cada intento: después de una espera, el `timestamp` del
      // intento anterior ya quedaría fuera de la ventana.
      const url = secret === null ? this.buildUrl(path, params) : this.signedUrl(path, params, secret)
      // El plazo cubre también la lectura del cuerpo: `res.json()` corre bajo la misma señal.
      const signal = AbortSignal.timeout(this.requestTimeoutMs)
      let res: Response
      try {
        res = await this.fetchImpl(url, { method, headers, signal })
      } catch (cause) {
        const reason = isTimeout(cause) ? this.timeoutReason() : 'falló la red'
        if (attempt >= retries) throw new BinanceNetworkError(`Binance: ${reason} en ${path}`, path, { cause: signed ? redactedCause(cause) : cause })
        await this.backoff(attempt, null, path, reason)
        continue
      }
      this.observeWeight(res)
      if (res.ok) {
        try {
          return (await res.json()) as T
        } catch (cause) {
          // Cuerpo truncado o no JSON (un proxy en el medio): se trata como fallo de red.
          const reason = isTimeout(cause) ? this.timeoutReason() : 'respuesta ilegible'
          if (attempt >= retries) throw new BinanceNetworkError(`Binance: ${reason} en ${path}`, path, { cause: signed ? redactedCause(cause) : cause })
          await this.backoff(attempt, null, path, reason)
          continue
        }
      }

      const error = await readError(res)
      const message = redactSignature(`${error?.msg ?? res.statusText ?? 'error'} (HTTP ${res.status} ${path})`)
      const code = error?.code ?? null
      // Nuestro reloj se corrió respecto del de Binance: se vuelve a medir y se reintenta una vez.
      if (signed && code === -1021 && !resynced) {
        resynced = true
        await this.syncTime(priority)
        continue
      }
      if (res.status === 451) throw new BinanceGeoBlocked(message, { status: 451, code, path })
      if (res.status === 429 || res.status === 418) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now())
        if (attempt >= retries) {
          // Aunque no se reintente, Binance castiga a toda la IP: el limitador se frena igual.
          this.limiter.holdUntil(this.now() + this.backoffDelay(attempt, retryAfterMs))
          throw new BinanceRateLimited(message, { status: res.status, code, path, retryAfterMs })
        }
        await this.backoff(attempt, retryAfterMs, path, `HTTP ${res.status}`, true)
        continue
      }
      if (res.status >= 500) {
        if (attempt >= retries) throw new BinanceHttpError(message, { status: res.status, code, path })
        await this.backoff(attempt, null, path, `HTTP ${res.status}`)
        continue
      }
      throw new BinanceHttpError(message, { status: res.status, code, path })
    }
  }

  // El limitador sólo recibe la prioridad cuando es alta (la normal es su default).
  private acquire(cost: Cost, priority: Priority): Promise<void> {
    return priority === 'high' ? this.limiter.acquire(cost.kind, cost.weight, 'high') : this.limiter.acquire(cost.kind, cost.weight)
  }

  private requireSecret(): string {
    if (this.apiKey === null || this.apiSecret === null) throw new Error('Binance: este pedido necesita la clave y el secret de la cuenta')
    return this.apiSecret
  }

  // Con la hora de llegada de la respuesta (no la de salida, que incluye la espera del
  // limitador): el `timestamp` queda a lo sumo medio viaje atrasado, dentro de la ventana.
  private syncTime(priority: Priority): Promise<void> {
    this.syncing ??= this.request<RawServerTime>(this.timePath, {}, { kind: 'weight', weight: 1 }, { priority })
      .then(({ serverTime }) => {
        this.timeOffset = serverTime - this.now()
      })
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  private signedUrl(path: string, params: Params, secret: string): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value))
    }
    query.set('recvWindow', String(RECV_WINDOW_MS))
    query.set('timestamp', String(Math.round(this.now() + (this.timeOffset ?? 0))))
    const payload = query.toString()
    return `${this.baseUrl}${path}?${payload}&signature=${signQuery(payload, secret)}`
  }

  private timeoutReason(): string {
    return `sin respuesta en ${this.requestTimeoutMs} ms`
  }

  private buildUrl(path: string, params: Params): string {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private observeWeight(res: Response): void {
    const header = res.headers.get('x-mbx-used-weight-1m')
    if (header === null) return
    const used = Number(header)
    if (Number.isFinite(used)) this.limiter.observeHeader(used)
  }

  // Espera exponencial (base·2^intento, con tope) o lo que pida Retry-After si es mayor.
  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    const exponential = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt)
    return Math.max(exponential, retryAfterMs ?? 0)
  }

  // En un 429/418 además frena el limitador entero: Binance castiga a toda la IP.
  private async backoff(attempt: number, retryAfterMs: number | null, path: string, reason: string, holdLimiter = false): Promise<void> {
    const delay = this.backoffDelay(attempt, retryAfterMs)
    if (holdLimiter) this.limiter.holdUntil(this.now() + delay)
    this.logger.warn({ path, reason, attempt: attempt + 1, delayMs: delay }, 'Binance: reintento con espera')
    await this.sleep(delay)
  }
}

// `AbortSignal.timeout` rechaza con un DOMException de nombre TimeoutError.
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// La causa de un fallo de red en un pedido firmado, sin la firma (un `fetch` podría
// citar la URL entera en su mensaje).
function redactedCause(cause: unknown): Error {
  const error = new Error(redactSignature(errorMessage(cause)))
  if (cause instanceof Error) error.name = cause.name
  return error
}

async function readError(res: Response): Promise<RawBinanceError | null> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'msg' in body) {
      const { code, msg } = body as { code?: unknown; msg?: unknown }
      return { code: typeof code === 'number' ? code : 0, msg: typeof msg === 'string' ? msg : res.statusText }
    }
  } catch {
    // Cuerpo no JSON (p. ej. HTML de un proxy): nos quedamos con el status.
  }
  return null
}

function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}
