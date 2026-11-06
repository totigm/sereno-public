// Errores tipados del cliente REST. El runtime los distingue para reflejarlos en
// `bot_status` ("Binance rechaza la IP del worker") y decidir si reintenta.

export class BinanceError extends Error {
  readonly status: number
  readonly code: number | null
  readonly path: string

  constructor(message: string, { status, code = null, path }: { status: number; code?: number | null; path: string }) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.path = path
  }
}

// HTTP 451: Binance bloquea la IP por jurisdicción o por rango de datacenter.
export class BinanceGeoBlocked extends BinanceError {}

// HTTP 429 (límite excedido) o 418 (IP baneada por insistir después del 429).
export class BinanceRateLimited extends BinanceError {
  readonly retryAfterMs: number | null

  constructor(message: string, opts: { status: number; code?: number | null; path: string; retryAfterMs: number | null }) {
    super(message, opts)
    this.retryAfterMs = opts.retryAfterMs
  }
}

// Cualquier otro 4xx/5xx con el `{ code, msg }` de Binance cuando viene.
export class BinanceHttpError extends BinanceError {}

// Clave inválida o de formato inválido (-2015, -2014), firma rechazada (-1022) o sin
// permiso para la cuenta de futuros (los -4xxx). Reintentar no lo arregla: lo arregla Toti.
const KEY_CODES: ReadonlySet<number> = new Set([-2015, -2014, -1022])

export function isKeyRejected(err: unknown): boolean {
  if (!(err instanceof BinanceHttpError)) return false
  if (err.code !== null && (KEY_CODES.has(err.code) || (err.code <= -4000 && err.code > -5000))) return true
  return err.status === 401
}

// La red falló o la respuesta no se pudo leer (sin status HTTP).
export class BinanceNetworkError extends Error {
  readonly path: string

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BinanceNetworkError'
    this.path = path
  }
}
