import type { Logger } from 'pino'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import type { FakeBinance } from '../../src/binance/fake/server'
import { BinanceHttp } from '../../src/binance/http'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceRest } from '../../src/binance/rest'
import { BinanceTradeRest } from '../../src/binance/trade-rest'
import { BINANCE_LIMITS } from '../../src/config'

// Cliente REST real contra el Binance falso con un reloj compartido (fijo o que avanza):
// el falso sirve las series hasta `now` y el cliente marca cerradas las velas que
// cerraron antes. `clientLagMs` atrasa el reloj del cliente respecto del de Binance.
export function restFor(
  fake: FakeBinance,
  now: number | (() => number),
  { clientLagMs = 0 }: { clientLagMs?: number } = {},
): { rest: BinanceRest; limiter: RateLimiter } {
  const clock = typeof now === 'number' ? () => now : now
  const clientClock = () => clock() - clientLagMs
  fake.now = clock
  const limiter = new RateLimiter({ ...BINANCE_LIMITS, now: clientClock })
  const rest = new BinanceRest({ baseUrl: fake.baseUrl, limiter, now: clientClock, maxRetries: 0 })
  return { rest, limiter }
}

export interface TradeKit {
  trade: BinanceTradeRest
  // El de `fapi`, para mandar pedidos crudos al falso.
  http: BinanceHttp
  limiter: RateLimiter
  // Las esperas pedidas por el cliente (no esperan de verdad).
  sleeps: number[]
}

export interface TradeKitOptions {
  // Sin `/sapi`, como en testnet.
  sapi?: boolean
  logger?: Logger
  fetch?: typeof fetch
  apiSecret?: string
  // El reloj del cliente: limitadores y `timestamp` de las firmas (por defecto el de la máquina).
  now?: () => number
  // El limitador de `fapi` (por defecto uno propio): el proceso real comparte el del mercado.
  limiter?: RateLimiter
}

// Cliente de órdenes real contra el Binance falso, con la clave falsa y sin esperas reales.
// `/sapi` va al mismo falso, con su propio limitador (en Binance es otro límite de peso).
export function tradeFor(fake: FakeBinance, { sapi = true, logger, fetch, apiSecret = FAKE_API_SECRET, now, limiter: shared }: TradeKitOptions = {}): TradeKit {
  const sleeps: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms)
  }
  const limits = { ...BINANCE_LIMITS, ...(now ? { now } : {}) }
  const limiter = shared ?? new RateLimiter(limits)
  const common = { baseUrl: fake.baseUrl, apiKey: FAKE_API_KEY, apiSecret, sleep, maxRetries: 0, ...(logger ? { logger } : {}), ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) }
  const http = new BinanceHttp({ ...common, limiter })
  const sapiHttp = sapi ? new BinanceHttp({ ...common, limiter: new RateLimiter(limits), timePath: '/api/v3/time' }) : null
  const trade = new BinanceTradeRest({ http, sapi: sapiHttp, sleep, ...(logger ? { logger } : {}) })
  return { trade, http, limiter, sleeps }
}
