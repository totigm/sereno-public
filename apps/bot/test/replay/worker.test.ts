import { performance } from 'node:perf_hooks'
import { MessageChannel } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initialLearningState } from '@sereno/core/src/learning/state'
import { BinanceHttpError } from '../../src/binance/errors'
import { FakeBinance } from '../../src/binance/fake/server'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget, type CallBudget } from '../../src/jobs/budget'
import { createLogger, silentLogger } from '../../src/logger'
import { Scheduler } from '../../src/live/scheduler'
import { realClock } from '../../src/live/timers'
import type { ReplayRest } from '../../src/replay/download'
import { isRpcRequest, RpcClient, serveRpc } from '../../src/replay/rpc'
import { computeTuning, type TuningTask } from '../../src/replay/tuning'
import { relog, startWorker, WorkerExited } from '../../src/replay/worker'
import { restFor } from '../helpers/binance'
import { openTestDb, TEST_URL, type TestDb } from '../helpers/db'
import { TWO_COINS } from '../helpers/live'

const NOW = Date.UTC(2026, 9, 31, 12, 7)

let fake: FakeBinance
let t: TestDb
const created: string[] = []

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await t.query('delete from sessions where id = any($1)', [created])
  await fake.stop()
  await t.close()
})

async function requestReplay(days: number): Promise<string> {
  const row = await t.repos.sessions.createReplay({
    name: 'Replay en worker T21',
    capitalInicial: 1000,
    settings: TWO_COINS,
    learningOrigin: 'zero',
    replayParams: { days, capital: 1000, learningOrigin: 'zero', paramTuning: false },
  })
  created.push(row.id)
  return row.id
}

function countingBudget(): { budget: CallBudget; calls: () => number } {
  const inner = weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW)
  let calls = 0
  return {
    budget: {
      acquire: (kind, weight) => {
        calls += 1
        return inner.acquire(kind, weight)
      },
    },
    calls: () => calls,
  }
}

describe('startWorker', () => {
  it('corre el replay en otro hilo: el programador del vivo sigue disparando y REST y presupuesto son los del principal', async () => {
    fake.reset()
    const sessionId = await requestReplay(10)
    const { budget, calls } = countingBudget()
    const ticks: number[] = []
    const scheduler = new Scheduler({ clock: realClock, onError: () => undefined })
    scheduler.add({
      name: 'ciclo-de-prueba',
      period: 20,
      run: async () => {
        ticks.push(Date.now())
      },
    })
    const started = Date.now()
    const idleFrom = performance.eventLoopUtilization()
    const run = startWorker({ rest: restFor(fake, NOW).rest, budget, logger: silentLogger, databaseUrl: TEST_URL }, { kind: 'replay', sessionId, now: NOW })
    const outcome = await run.result
    const elapsed = Date.now() - started
    const utilization = performance.eventLoopUtilization(idleFrom).utilization
    scheduler.stop()

    expect(outcome).toBe('listo')
    expect(await t.repos.sessions.get(sessionId)).toMatchObject({ status: 'listo', progreso: 1 })
    expect(await t.repos.sessions.getReport(sessionId)).not.toBeNull()
    expect(fake.requests.length).toBeGreaterThan(0)
    expect(calls()).toBeGreaterThan(0)
    // Mientras el worker descargaba y simulaba, el programador siguió disparando a tiempo y
    // el hilo principal estuvo casi ocioso (corrido en el mismo hilo, el replay lo ocupa
    // más del 80 % del tiempo).
    const gaps = ticks.slice(1).map((at, i) => at - ticks[i]!)
    expect(ticks.length).toBeGreaterThan(elapsed / 20 / 2)
    expect(Math.max(...gaps)).toBeLessThan(100)
    expect(utilization).toBeLessThan(0.3)
  }, 60_000)

  it('corre el walk-forward semanal en otro hilo y devuelve el mismo veredicto que en el principal', async () => {
    fake.reset()
    const task: TuningTask = {
      kind: 'tuning',
      settings: TWO_COINS,
      learning: initialLearningState(NOW - 30 * 86_400_000),
      capital: 1000,
      now: NOW,
      grid: [
        { theta: 0.3, k: 1.5, tpR: 2, trailingR: 1 },
        { theta: 0.45, k: 2, tpR: 3, trailingR: 1.5 },
      ],
      criteria: { minTrades: 1 },
    }
    const viaWorker = await startWorker({ rest: restFor(fake, NOW).rest, budget: countingBudget().budget, logger: silentLogger, databaseUrl: TEST_URL }, task).result
    const inProcess = await computeTuning({ rest: restFor(fake, NOW).rest, repos: t.repos, budget: countingBudget().budget, logger: silentLogger }, task)

    expect(viaWorker).toEqual(inProcess)
    expect(viaWorker.criteria.minTrades).toBe(1)
  }, 60_000)

  it('terminate corta el worker: el resultado se rechaza', async () => {
    fake.reset()
    const sessionId = await requestReplay(3)
    const run = startWorker({ rest: restFor(fake, NOW).rest, budget: countingBudget().budget, logger: silentLogger, databaseUrl: TEST_URL }, { kind: 'replay', sessionId, now: NOW })
    await run.terminate()
    await expect(run.result).rejects.toBeInstanceOf(WorkerExited)
  })
})

describe('rpc', () => {
  it('los errores de Binance cruzan con su clase: un 400 sigue siendo de un símbolo', async () => {
    const { port1, port2 } = new MessageChannel()
    const rest = {
      klines: async () => {
        throw new BinanceHttpError('Invalid symbol.', { status: 400, code: -1121, path: '/fapi/v1/klines' })
      },
      exchangeInfo: async () => [],
    } as unknown as ReplayRest
    port1.on('message', (m: unknown) => {
      if (isRpcRequest(m)) void serveRpc(port1, { rest, budget: { acquire: async () => undefined } }, m)
    })
    const client = new RpcClient(port2)
    port2.on('message', (m: unknown) => client.receive(m))

    expect(await client.rest.exchangeInfo()).toEqual([])
    const error = await client.rest.klines('ETHUSDT', '15m', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BinanceHttpError)
    expect(error).toMatchObject({ status: 400, code: -1121, message: 'Invalid symbol.' })
    port1.close()
  })

  it('una respuesta que no se puede mandar al worker le llega como error y no tumba al principal', async () => {
    const { port1, port2 } = new MessageChannel()
    // Una función no se puede clonar entre hilos: `postMessage` tira DataCloneError.
    const rest = { exchangeInfo: async () => [() => undefined] } as unknown as ReplayRest
    const served: Promise<void>[] = []
    port1.on('message', (m: unknown) => {
      if (isRpcRequest(m)) served.push(serveRpc(port1, { rest, budget: { acquire: async () => undefined } }, m))
    })
    const client = new RpcClient(port2)
    port2.on('message', (m: unknown) => client.receive(m))

    const error = await client.rest.exchangeInfo().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/clon/i)
    await expect(Promise.all(served)).resolves.toBeDefined()
    port1.close()
  })
})

describe('relog', () => {
  function capture() {
    const lines: string[] = []
    const logger = createLogger({ level: 'trace', destination: { write: (line: string) => void lines.push(line) } })
    return { logger, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
  }

  it('reescribe en el logger del principal cada línea de pino del worker, con su nivel y sus campos', () => {
    const { logger, entries } = capture()
    relog(logger, JSON.stringify({ level: 40, time: 1, msg: 'Replay: Binance rechazó los datos de la moneda', symbol: 'ETHUSDT' }))
    expect(entries()).toEqual([expect.objectContaining({ level: 40, msg: 'Replay: Binance rechazó los datos de la moneda', symbol: 'ETHUSDT' })])
  })

  it('una línea que no es un objeto JSON no tira: queda como aviso con el texto', () => {
    const { logger, entries } = capture()
    expect(() => relog(logger, 'no es json')).not.toThrow()
    expect(() => relog(logger, 'null')).not.toThrow()
    expect(entries()).toEqual([
      expect.objectContaining({ level: 40, line: 'no es json' }),
      expect.objectContaining({ level: 40, line: 'null' }),
    ])
  })
})
