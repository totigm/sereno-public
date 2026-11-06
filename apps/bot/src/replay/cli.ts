// `pnpm bot replay --days 90 --capital 1000 [--learning zero|current] [--tuning]`: pide un
// replay y lo corre en este proceso contra la base de `DATABASE_URL`, con los ajustes de la
// simulación en vivo activa (o los por defecto). Toma el lease del replay al crearlo, así
// el bot en vivo no lo agarra de su cola ni lo da por huérfano mientras corre. Ctrl-C lo
// cancela (se corta al terminar el día que estaba simulando).

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createDirectDb, createRepos, type Repos } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { RateLimiter } from '../binance/rate-limiter'
import { BinanceRest } from '../binance/rest'
import { loadConfig } from '../config'
import { loadRootEnv } from '../env'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../jobs/budget'
import { errorMessage } from '../jobs/errors'
import { createLogger } from '../logger'
import { REPLAY_LEASE_TTL_MS, REPLAY_POLL_MS } from './queue'
import { runReplaySession, type ReplayOutcome } from './run'

export interface ReplayRequest {
  days: number
  capital: number
  learningOrigin: 'zero' | 'current'
  paramTuning: boolean
}

const PROGRESS_POLL_MS = 2_000

export function parseReplayArgs(args: readonly string[]): ReplayRequest {
  const { values } = parseArgs({
    args: [...args],
    options: { days: { type: 'string', default: '90' }, capital: { type: 'string', default: '1000' }, learning: { type: 'string', default: 'zero' }, tuning: { type: 'boolean', default: false } },
  })
  const days = Number(values.days)
  const capital = Number(values.capital)
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RangeError(`--days tiene que ser un entero entre 1 y 365 (recibí ${values.days})`)
  if (!Number.isFinite(capital) || capital <= 0) throw new RangeError(`--capital tiene que ser positivo (recibí ${values.capital})`)
  if (values.learning !== 'zero' && values.learning !== 'current') throw new RangeError(`--learning es zero o current (recibí ${values.learning})`)
  return { days, capital, learningOrigin: values.learning, paramTuning: values.tuning }
}

// Devuelve el código de salida: 0 si quedó listo.
export async function runReplayCli(args: readonly string[]): Promise<number> {
  let request: ReplayRequest
  try {
    request = parseReplayArgs(args)
  } catch (error) {
    console.error(`sereno · ${errorMessage(error)}`)
    return 2
  }
  loadRootEnv()
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, pretty: process.stderr.isTTY })
  const db = createDirectDb(config.databaseUrl, { max: 2 })
  const repos = createRepos(db)
  const instanceId = `cli-${randomUUID()}`
  const rest = new BinanceRest({ baseUrl: config.binance.restUrl, limiter: new RateLimiter({ ...config.binance.limits }), apiKey: config.binance.apiKey, logger })
  try {
    const settings = await currentSettings(repos)
    const row = await db.transaction(async (tx) => {
      const r = createRepos(tx)
      const created = await r.sessions.createReplay({
        name: `Replay de ${request.days} días`,
        capitalInicial: request.capital,
        settings,
        learningOrigin: request.learningOrigin === 'zero' ? 'zero' : 'continued',
        replayParams: request,
      })
      await r.bot.acquireLease(created.id, instanceId, REPLAY_LEASE_TTL_MS)
      return created
    })
    console.error(`sereno · replay ${row.id}: ${request.days} días con ${request.capital} USDT`)
    const lease = setInterval(() => {
      repos.bot.acquireLease(row.id, instanceId, REPLAY_LEASE_TTL_MS).catch((error: unknown) => logger.warn({ err: errorMessage(error) }, 'No pude renovar el lease del replay'))
    }, REPLAY_POLL_MS)
    const progress = watchProgress(repos, row.id)
    const cancel = (): void => {
      repos.sessions
        .get(row.id)
        .then((current) => repos.sessions.updateProgress(row.id, { status: 'cancelado', progreso: current?.progreso ?? 0, mensaje: 'Cancelado desde la línea de comandos.' }))
        .catch((error: unknown) => logger.error({ err: errorMessage(error) }, 'No pude cancelar el replay'))
    }
    process.once('SIGINT', cancel)
    let outcome: ReplayOutcome
    try {
      outcome = await runReplaySession({ db, rest, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE), logger, now: Date.now }, row.id)
    } finally {
      process.off('SIGINT', cancel)
      clearInterval(lease)
      clearInterval(progress)
      await repos.bot.releaseLease(row.id, instanceId)
    }
    const final = await repos.sessions.get(row.id)
    console.error(`sereno · replay ${row.id}: ${outcome} · ${final?.mensaje ?? ''}`)
    return outcome === 'listo' ? 0 : 1
  } finally {
    await db.$client.end()
  }
}

// Los ajustes vigentes de la simulación en vivo activa; sin ella, los por defecto.
async function currentSettings(repos: Repos): Promise<Settings> {
  const live = await repos.sessions.getActive('paper_live')
  if (!live) return DEFAULT_SETTINGS
  return (await repos.settings.get(live.id))?.config ?? live.settingsSnapshot
}

// Muestra el avance cada vez que cambia el mensaje.
function watchProgress(repos: Repos, sessionId: string): ReturnType<typeof setInterval> {
  let last = ''
  return setInterval(() => {
    repos.sessions
      .get(sessionId)
      .then((row) => {
        if (row?.mensaje && row.mensaje !== last) console.error(`sereno · ${row.mensaje}`)
        last = row?.mensaje ?? last
      })
      .catch(() => undefined)
  }, PROGRESS_POLL_MS)
}
