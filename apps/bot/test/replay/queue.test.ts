import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../../src/logger'
import { ORPHAN_MESSAGE, REPLAY_LEASE_TTL_MS, ReplayQueue, SHUTDOWN_MESSAGE } from '../../src/replay/queue'
import type { ReplayOutcome } from '../../src/replay/run'
import { WorkerExited, type WorkerRun } from '../../src/replay/worker'
import { openTestDb, type TestDb } from '../helpers/db'
import { TWO_COINS } from '../helpers/live'

const INSTANCE = 'bot-t21-cola'

let t: TestDb

beforeAll(async () => {
  t = await openTestDb()
})

afterAll(async () => {
  await t.query(`delete from sessions where kind = 'replay' and name = 'Cola T21'`)
  await t.close()
})

beforeEach(async () => {
  // Los replays sin terminar que dejaron otros archivos ocuparían la cola.
  await t.query(`delete from sessions where kind = 'replay' and status in ('en_cola', 'descargando', 'simulando')`)
})

async function requestReplay(): Promise<string> {
  const row = await t.repos.sessions.createReplay({
    name: 'Cola T21',
    capitalInicial: 1000,
    settings: TWO_COINS,
    learningOrigin: 'zero',
    replayParams: { days: 3, capital: 1000, learningOrigin: 'zero', paramTuning: false },
  })
  return row.id
}

interface FakeRun extends WorkerRun<ReplayOutcome> {
  finish(outcome: ReplayOutcome): void
}

function fakeWorkers() {
  const started: string[] = []
  const runs = new Map<string, FakeRun>()
  const start = (sessionId: string): FakeRun => {
    let resolve!: (o: ReplayOutcome) => void
    let reject!: (e: Error) => void
    const result = new Promise<ReplayOutcome>((res, rej) => {
      resolve = res
      reject = rej
    })
    const run: FakeRun = { result, finish: resolve, terminate: vi.fn(async () => reject(new WorkerExited(1))) }
    started.push(sessionId)
    runs.set(sessionId, run)
    return run
  }
  return { started, runs, start }
}

function queueWith(start: (id: string) => WorkerRun<ReplayOutcome>): ReplayQueue {
  return new ReplayQueue({ repos: t.repos, instanceId: INSTANCE, start, logger: silentLogger, pollMs: 60_000 })
}

describe('ReplayQueue', () => {
  it('corre uno a la vez, en el orden en que se pidieron', async () => {
    const first = await requestReplay()
    const second = await requestReplay()
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()
    await vi.waitFor(() => expect(workers.started).toEqual([first]))
    queue.wake()
    await new Promise((r) => setTimeout(r, 50))
    expect(workers.started).toEqual([first])

    await t.repos.sessions.updateProgress(first, { status: 'listo', progreso: 1, mensaje: 'Listo' })
    workers.runs.get(first)!.finish('listo')
    await vi.waitFor(() => expect(workers.started).toEqual([first, second]))
    // El lease del que terminó se soltó.
    expect(await t.repos.bot.acquireLease(first, 'otra-instancia', REPLAY_LEASE_TTL_MS)).toBe(true)
    await queue.stop()
  })

  it('un replay a medias sin nadie que lo corra (el bot se reinició) queda fallido con un mensaje claro', async () => {
    const orphan = await requestReplay()
    await t.repos.sessions.updateProgress(orphan, { status: 'simulando', progreso: 0.6, mensaje: 'Simulando · día 2 de 3' })
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()

    await vi.waitFor(async () => expect(await t.repos.sessions.get(orphan)).toMatchObject({ status: 'fallido', progreso: 0.6, mensaje: ORPHAN_MESSAGE }))
    expect(workers.started).toEqual([])
    await queue.stop()
  })

  it('si otro proceso corre un replay (la línea de comandos), no lo toca y no arranca otro', async () => {
    const elsewhere = await requestReplay()
    await t.repos.sessions.updateProgress(elsewhere, { status: 'descargando', progreso: 0.1, mensaje: 'Descargando velas · 1 de 2 monedas' })
    await t.repos.bot.acquireLease(elsewhere, 'cli', REPLAY_LEASE_TTL_MS)
    const waiting = await requestReplay()
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()
    await new Promise((r) => setTimeout(r, 100))

    expect(await t.repos.sessions.get(elsewhere)).toMatchObject({ status: 'descargando' })
    expect(await t.repos.sessions.get(waiting)).toMatchObject({ status: 'en_cola' })
    expect(workers.started).toEqual([])
    await queue.stop()
    await t.repos.bot.releaseLease(elsewhere, 'cli')
  })

  it('si pierde el lease del replay que corre (venció y otro proceso lo tomó), corta su worker y deja el lease al otro', async () => {
    const id = await requestReplay()
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()
    await vi.waitFor(() => expect(workers.started).toEqual([id]))
    await t.repos.sessions.updateProgress(id, { status: 'simulando', progreso: 0.5, mensaje: 'Simulando · día 1 de 3' })
    // El bot estuvo colgado más de 30 s: otro proceso tomó el lease y dio el replay por cortado.
    await t.query(`update bot_lease set lease_until = now() - interval '1 second' where session_id = $1`, [id])
    expect(await t.repos.bot.acquireLease(id, 'otra-instancia', REPLAY_LEASE_TTL_MS)).toBe(true)
    await t.repos.sessions.updateProgress(id, { status: 'fallido', progreso: 0.5, mensaje: ORPHAN_MESSAGE })

    queue.wake()

    await vi.waitFor(() => expect(workers.runs.get(id)!.terminate).toHaveBeenCalled())
    await queue.stop()
    expect(await t.repos.sessions.get(id)).toMatchObject({ status: 'fallido', mensaje: ORPHAN_MESSAGE })
    expect(await t.repos.bot.acquireLease(id, INSTANCE, REPLAY_LEASE_TTL_MS)).toBe(false)
    await t.repos.bot.releaseLease(id, 'otra-instancia')
  })

  it('si el worker termina sin resultado, el replay queda fallido con una frase y suelta el lease', async () => {
    const id = await requestReplay()
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()
    await vi.waitFor(() => expect(workers.started).toEqual([id]))
    await t.repos.sessions.updateProgress(id, { status: 'simulando', progreso: 0.3, mensaje: 'Simulando · día 1 de 3' })

    await workers.runs.get(id)!.terminate()

    await vi.waitFor(async () =>
      expect(await t.repos.sessions.get(id)).toMatchObject({ status: 'fallido', progreso: 0.3, mensaje: 'Falló: el proceso que corría el replay se cortó sin terminar.' }),
    )
    await vi.waitFor(async () => expect(await t.repos.bot.acquireLease(id, 'otra-instancia', REPLAY_LEASE_TTL_MS)).toBe(true))
    await queue.stop()
  })

  it('al apagar corta el worker, deja el replay fallido y suelta el lease', async () => {
    const id = await requestReplay()
    const workers = fakeWorkers()
    const queue = queueWith(workers.start)
    queue.start()
    await vi.waitFor(() => expect(workers.started).toEqual([id]))
    await t.repos.sessions.updateProgress(id, { status: 'simulando', progreso: 0.5, mensaje: 'Simulando · día 1 de 3' })

    await queue.stop()

    expect(workers.runs.get(id)!.terminate).toHaveBeenCalled()
    expect(await t.repos.sessions.get(id)).toMatchObject({ status: 'fallido', progreso: 0.5, mensaje: SHUTDOWN_MESSAGE })
    expect(await t.repos.bot.acquireLease(id, 'otra-instancia', REPLAY_LEASE_TTL_MS)).toBe(true)
  })
})
