// Lo que el proceso arma para la sesión real a partir de la configuración. En mainnet las
// órdenes van por el mismo limitador que los datos de papel (es el mismo límite de IP en
// Binance) con prioridad alta, y la sesión real usa el stream y el REST de papel. En testnet
// todo es propio: otro host, otro límite, otros precios.

import type { Repos } from '@sereno/db'
import { BinanceHttp, type BinanceHttpOptions } from '../binance/http'
import { RateLimiter } from '../binance/rate-limiter'
import { BinanceRest } from '../binance/rest'
import { BinanceTradeRest } from '../binance/trade-rest'
import { UserDataStream } from '../binance/user-stream'
import { MarketStream } from '../binance/ws'
import { BINANCE_LIMITS, type BotConfig } from '../config'
import type { LiveRest } from '../live/live-types'
import type { Logger } from '../logger'
import type { RealProcess } from './real-session'
import { realUniverse } from './universe'

export interface RealProcessDeps {
  config: BotConfig['real']
  // El REST de papel (mainnet): catálogo y volúmenes del universo, y el mercado en mainnet.
  paperRest: LiveRest
  paperLimiter: RateLimiter
  repos: Repos
  logger: Logger
}

export function realProcess({ config, paperRest, paperLimiter, repos, logger }: RealProcessDeps): RealProcess {
  const testnet = config.env === 'testnet'
  const limiter = testnet ? new RateLimiter({ ...BINANCE_LIMITS }) : paperLimiter
  const testnetRest = testnet ? new BinanceRest({ baseUrl: config.restUrl, limiter, logger }) : null
  return {
    config,
    trade: realTradeRest(config, limiter, logger),
    userStream: (trade) => new UserDataStream({ trade, url: config.userWsUrl, logger }),
    ...(testnetRest ? { market: { rest: testnetRest, streamFactory: (symbols: string[]) => new MarketStream({ symbols, url: config.marketWsUrl, logger }) } } : {}),
    refreshUniverse: realUniverse({ mainnet: { rest: paperRest, repos, logger }, testnet: testnetRest }),
  }
}

// El cliente de órdenes; null sin las claves de operación. `http` ajusta reintentos (el
// interruptor de la terminal no espera minutos).
export function realTradeRest(
  config: Pick<BotConfig['real'], 'apiKey' | 'apiSecret' | 'restUrl' | 'sapiUrl'>,
  limiter: RateLimiter,
  logger: Logger,
  http: Pick<BinanceHttpOptions, 'fetch' | 'maxRetries' | 'backoffBaseMs'> = {},
): BinanceTradeRest | null {
  const { apiKey, apiSecret } = config
  if (apiKey === null || apiSecret === null) return null
  const common = { ...http, apiKey, apiSecret, logger }
  const fapi = new BinanceHttp({ ...common, baseUrl: config.restUrl, limiter })
  // `/sapi` es otro límite de peso en Binance.
  const sapi = config.sapiUrl ? new BinanceHttp({ ...common, baseUrl: config.sapiUrl, limiter: new RateLimiter({ ...BINANCE_LIMITS }), timePath: '/api/v3/time' }) : null
  return new BinanceTradeRest({ http: fapi, sapi, logger })
}
