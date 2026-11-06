import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { SessionRow } from '@sereno/db'
import { FakeBinance } from '../../src/binance/fake/server'
import { openTestDb, type TestDb } from '../helpers/db'
import { commandRow, createActiveSession, dropSession, enqueueCommand, pauseAuto, startHarness, type Harness } from '../helpers/live'

// Los comandos que no cierran posiciones: blindaje, aprendizaje y replays.
const START = Date.UTC(2026, 9, 31, 12, 5, 0)
const WAIT = { timeout: 5_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let session: SessionRow
let h: Harness | null = null
let replays: string[] = []
const queued: string[] = []
const cancelled: string[] = []

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  fake.reset()
  session = await createActiveSession(t)
  queued.length = 0
  cancelled.length = 0
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  for (const id of [session.id, ...replays]) await dropSession(t, id)
  replays = []
})

async function started(): Promise<Harness> {
  h = await startHarness({
    t,
    fake,
    start: START,
    hooks: { onReplayQueued: (id) => queued.push(id), onReplayCancelled: (id) => cancelled.push(id) },
  })
  await h.runtime.ready()
  return h
}

async function run(kind: Parameters<typeof enqueueCommand>[2], payload: Record<string, unknown> = {}) {
  const id = await enqueueCommand(t, session.id, kind, payload)
  await h!.clock.advance(3_000)
  await vi.waitFor(async () => expect((await commandRow(t, session.id, id))?.status).toMatch(/^(done|failed)$/), WAIT)
  return (await commandRow(t, session.id, id))!
}

describe('comandos de blindaje, aprendizaje y replays', { timeout: 30_000 }, () => {
  it('release_protected vuelve a usar lo blindado y levanta la pausa por falta de margen', async () => {
    await t.repos.sessions.updateShield(session.id, { protegido: 1_000, baseBlindaje: 1_000 })
    const paused = await pauseAuto(t, session.id, START - 60_000, 'Me pausé solo: los US$ 1.000 están blindados y no queda ganancia para operar.')
    await started()
    const row = await run('release_protected')
    expect(row).toMatchObject({ status: 'done', result: { ok: true } })
    expect(await t.repos.settings.get(session.id)).toMatchObject({ version: paused + 1, config: { pause: { paused: false, by: null } } })
    expect(await t.repos.sessions.get(session.id)).toMatchObject({ protegido: 0, baseBlindaje: 1_000 })
  })

  it('release_protected sin blindaje falla con el motivo y no toca la pausa de Toti', async () => {
    const before = await t.repos.settings.get(session.id)
    await started()
    const row = await run('release_protected')
    expect(row).toMatchObject({ status: 'failed', result: { ok: false, message: 'No había capital blindado.' } })
    expect((await t.repos.settings.get(session.id))?.version).toBe(before!.version)
  })

  it('reset_learning vuelve el aprendizaje al inicio y lo deja en el registro', async () => {
    await t.repos.learning.save(session.id, { ...initialLearningState(START - 86_400_000), closedTrades: 12, version: 7 })
    await started()
    expect(await run('reset_learning')).toMatchObject({ status: 'done', result: { ok: true } })
    expect(await t.repos.learning.get(session.id)).toMatchObject({ closedTrades: 0 })
    expect((await t.repos.learning.listLog(session.id)).map((e) => e.kind)).toContain('reset')
  })

  it('run_replay deja el replay en cola y avisa al worker; cancel_replay lo cancela', async () => {
    await started()
    const queuedRow = await run('run_replay', { days: 30, capital: 500, learningOrigin: 'current', paramTuning: false })
    expect(queuedRow).toMatchObject({ status: 'done', result: { ok: true } })
    const replayId = (queuedRow.result as { data: { replaySessionId: string } }).data.replaySessionId
    replays.push(replayId)
    expect(await t.repos.sessions.get(replayId)).toMatchObject({
      kind: 'replay',
      status: 'en_cola',
      capitalInicial: 500,
      learningOrigin: 'continued',
      replayParams: { days: 30, capital: 500, learningOrigin: 'current', paramTuning: false },
    })
    expect(queued).toEqual([replayId])

    expect(await run('cancel_replay', { replaySessionId: replayId })).toMatchObject({ status: 'done', result: { ok: true } })
    expect((await t.repos.sessions.get(replayId))?.status).toBe('cancelado')
    expect(cancelled).toEqual([replayId])
  })
})
