// `pnpm bot`: el proceso en vivo con la configuración del entorno: la simulación en papel y,
// en el mismo proceso, la sesión con plata real (que sin claves sólo informa qué le falta).
// SIGINT y SIGTERM lo apagan ordenadamente (guarda lo pendiente, último latido, suelta los
// leases); el siguiente proceso toma las sesiones sin esperar a que los leases venzan.

import { randomUUID } from 'node:crypto'
import { createDirectDb, createRepos } from '@sereno/db'
import { RateLimiter } from '../binance/rate-limiter'
import { BinanceRest } from '../binance/rest'
import { MarketStream } from '../binance/ws'
import { loadConfig } from '../config'
import { loadRootEnv } from '../env'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../jobs/budget'
import { errorMessage } from '../jobs/errors'
import { createLogger } from '../logger'
import { realProcess } from '../real/process'
import { ReplayQueue } from '../replay/queue'
import { startWorker, type WorkerDeps } from '../replay/worker'
import { accountTiersHook, learningHooks } from './hooks'
import { keepAwake } from './keep-awake'
import { startLive } from './runtime'
import { shutdownOnSignals } from './shutdown'

export async function runLive(): Promise<void> {
  loadRootEnv()
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, pretty: process.stdout.isTTY })
  const db = createDirectDb(config.databaseUrl, { max: 4 })
  const limiter = new RateLimiter({ ...config.binance.limits })
  const rest = new BinanceRest({
    baseUrl: config.binance.restUrl,
    limiter,
    apiKey: config.binance.apiKey,
    apiSecret: config.binance.apiSecret,
    logger,
  })
  const instanceId = randomUUID()
  // Uno por proceso: calentamientos, replays y el ajuste semanal comparten el mismo tope.
  const budget = weightBudget(WARMUP_WEIGHT_PER_MINUTE)
  const workers: WorkerDeps = { rest, budget, logger, databaseUrl: config.databaseUrl }
  const queue = new ReplayQueue({
    repos: createRepos(db),
    instanceId,
    start: (sessionId) => startWorker(workers, { kind: 'replay', sessionId, now: Date.now() }),
    logger,
  })
  const learning = learningHooks({ queue, workers, logger })
  const awake = keepAwake(logger)
  const runtime = await startLive({
    db,
    rest,
    streamFactory: (symbols) => new MarketStream({ symbols, url: config.binance.wsUrl, logger }),
    logger,
    instanceId,
    budget,
    hooks: { ...learning.hooks, accountTiers: accountTiersHook({ rest, logger }) },
    real: realProcess({ config: config.real, paperRest: rest, paperLimiter: limiter, repos: createRepos(db), logger }),
  })
  queue.start()
  logger.info({ instanceId }, 'Bot en vivo')

  shutdownOnSignals(process, async (signal) => {
    logger.info({ signal }, 'Apagando')
    try {
      await queue.stop()
      await learning.stop()
      await runtime.stop()
    } finally {
      awake()
      await db.$client.end()
    }
  }).catch((error: unknown) => {
    logger.error({ err: errorMessage(error) }, 'El apagado falló')
    process.exitCode = 1
  })
}
