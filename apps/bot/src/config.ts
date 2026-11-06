// Configuración del proceso del bot a partir del entorno (spec §12). Se valida una
// vez al arrancar; un faltante o un valor inválido corta con un mensaje que nombra
// la variable. Los límites de Binance son los verificados en la spec §3.

import { z } from 'zod'
import { BINANCE_ENVS, type BinanceEnv } from '@sereno/shared'
import { LOG_LEVELS } from './logger'

export const BINANCE_REST_URL = 'https://fapi.binance.com'
export const BINANCE_MARKET_WS_URL = 'wss://fstream.binance.com/market/stream'

export interface RealHosts {
  restUrl: string
  // `/sapi` (permisos de la clave); null en testnet, donde no existe.
  sapiUrl: string | null
  marketWsUrl: string
  // Base del user data stream: el cliente le agrega el listenKey.
  userWsUrl: string
}

// Hosts de la sesión real por entorno, los verificados en la cabecera de
// `binance/trade-types.ts` (general-info de USDⓈ-M: testnet en demo-fapi/demo-fstream). Las
// rutas `/market/` y `/private/` de testnet siguen las de mainnet: la documentación no dice
// otra cosa. Sin variables para pisarlos: apuntar a otro lado es cambiar este archivo.
export const REAL_HOSTS: Record<BinanceEnv, RealHosts> = {
  mainnet: {
    restUrl: BINANCE_REST_URL,
    sapiUrl: 'https://api.binance.com',
    marketWsUrl: BINANCE_MARKET_WS_URL,
    userWsUrl: 'wss://fstream.binance.com/private/ws',
  },
  testnet: {
    restUrl: 'https://demo-fapi.binance.com',
    sapiUrl: null,
    marketWsUrl: 'wss://demo-fstream.binance.com/market/stream',
    userWsUrl: 'wss://demo-fstream.binance.com/private/ws',
  },
}

export const BINANCE_LIMITS = { weightPerMinute: 2400, dataRequestsPer5m: 1000, fundingRequestsPer5m: 500 } as const

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL_UNPOOLED: z.string().min(1, 'falta DATABASE_URL_UNPOOLED (o DATABASE_URL como respaldo)'),
  BINANCE_REST_URL: z.url().default(BINANCE_REST_URL),
  // Las rutas legadas `/ws` y `/stream` fueron decomisionadas: sólo vale la ruta /market/.
  BINANCE_WS_URL: z
    .url()
    .default(BINANCE_MARKET_WS_URL)
    .refine((u) => u.includes('/market/'), 'tiene que apuntar a la ruta /market/ de Binance'),
  BINANCE_API_KEY: z.string().min(1).nullable().default(null),
  BINANCE_API_SECRET: z.string().min(1).nullable().default(null),
  // Las de operación van aparte de las de sólo lectura (spec de plata real, llave 1).
  BINANCE_TRADE_API_KEY: z.string().min(1).nullable().default(null),
  BINANCE_TRADE_API_SECRET: z.string().min(1).nullable().default(null),
  // Por defecto testnet: para operar con plata de verdad hay que escribir `mainnet` a propósito.
  BINANCE_ENV: z.enum(BINANCE_ENVS, 'tiene que ser testnet o mainnet').default('testnet'),
})

export interface BotConfig {
  logLevel: (typeof LOG_LEVELS)[number]
  databaseUrl: string
  binance: {
    restUrl: string
    wsUrl: string
    apiKey: string | null
    apiSecret: string | null
    limits: { weightPerMinute: number; dataRequestsPer5m: number; fundingRequestsPer5m: number }
  }
  real: RealHosts & {
    // Sólo con `SERENO_REAL_TRADING` exactamente `on`: "ON", "1" o "true" no prenden nada.
    enabled: boolean
    env: BinanceEnv
    apiKey: string | null
    apiSecret: string | null
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = EnvSchema.safeParse({
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL,
    BINANCE_REST_URL: env.BINANCE_REST_URL,
    BINANCE_WS_URL: env.BINANCE_WS_URL,
    BINANCE_API_KEY: env.BINANCE_API_KEY || null,
    BINANCE_API_SECRET: env.BINANCE_API_SECRET || null,
    BINANCE_TRADE_API_KEY: env.BINANCE_TRADE_API_KEY || null,
    BINANCE_TRADE_API_SECRET: env.BINANCE_TRADE_API_SECRET || null,
    // Vacía (como queda al copiar `.env.example`) cuenta como ausente.
    BINANCE_ENV: env.BINANCE_ENV || undefined,
  })
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
    throw new Error(`Configuración inválida:\n  ${problems.join('\n  ')}`)
  }
  const e = parsed.data
  return {
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_UNPOOLED,
    binance: {
      restUrl: e.BINANCE_REST_URL,
      wsUrl: e.BINANCE_WS_URL,
      apiKey: e.BINANCE_API_KEY,
      apiSecret: e.BINANCE_API_SECRET,
      limits: { ...BINANCE_LIMITS },
    },
    real: {
      enabled: env.SERENO_REAL_TRADING === 'on',
      env: e.BINANCE_ENV,
      apiKey: e.BINANCE_TRADE_API_KEY,
      apiSecret: e.BINANCE_TRADE_API_SECRET,
      ...REAL_HOSTS[e.BINANCE_ENV],
    },
  }
}
