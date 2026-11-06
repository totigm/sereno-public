import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { FakeBinance } from '../../src/binance/fake/server'
import type { HookContext } from '../../src/live/live-types'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, dropSession, startHarness, type Harness } from '../helpers/live'

// A las 13:02 corre el hook de retornos (cada hora, a los :02).
const START = Date.UTC(2026, 9, 31, 13, 1, 50)
const AT = Date.UTC(2026, 9, 31, 13, 2, 0)
const WAIT = { timeout: 5_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let session: SessionRow
let h: Harness | null = null

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
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  await dropSession(t, session.id)
})

describe('runtime en vivo: hooks de aprendizaje', { timeout: 30_000 }, () => {
  it('updateLearning cambia el aprendizaje del motor a partir del vigente y lo guarda con su bitácora', async () => {
    const contexts: HookContext[] = []
    h = await startHarness({ t, fake, start: START, hooks: { forwardReturns: async (ctx) => void contexts.push(ctx) } })
    await h.runtime.ready()
    h.openSocket()
    await h.clock.advanceTo(AT + 1_000)
    await vi.waitFor(() => expect(contexts).toHaveLength(1), WAIT)
    const ctx = contexts[0]!
    expect(ctx).toMatchObject({ sessionId: session.id, now: AT })
    const before = ctx.learning()

    await ctx.updateLearning((current) => ({
      state: { ...current, params: { ...current.params, theta: 0.45, since: AT }, version: current.version + 1 },
      log: [{ at: AT, kind: 'params', symbol: null, signal: null, message: 'Adopté θ 0,45.', sampleSize: 80, before: current.params, after: { theta: 0.45 } }],
    }))

    expect(ctx.learning()).toMatchObject({ params: { theta: 0.45, since: AT }, version: before.version + 1 })
    expect((await t.repos.learning.get(session.id))?.params.theta).toBe(0.45)
    expect((await t.repos.learning.listLog(session.id)).map((e) => [e.kind, e.message])).toContainEqual(['params', 'Adopté θ 0,45.'])
  })
})
