// @vitest-environment node
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { DirectDb, MarketSymbolView } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getMonedasData } from '@/lib/queries/monedas'
import { archiveSeeded, dropSessions, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const LEARNED = testSessionId('monedas_theta')
const FRESH = testSessionId('monedas_fresh')
const END = Date.now()
const START = END - 2 * 86_400_000

const SOL: MarketSymbolView = { symbol: 'SOLUSDT', markPrice: 170, change24h: 0.01, sPrime: 0.5, lean: 1, state: 'ready' }

beforeAll(async () => {
  for (const id of [LEARNED, FRESH]) {
    await seedSession(t, id, { status: SEEDING_STATUS, startedAt: START, endedAt: END })
    await t.repos.market.upsert(id, [SOL])
  }
  const initial = initialLearningState(START)
  await t.repos.learning.save(LEARNED, { ...initial, params: { ...initial.params, theta: 0.4 } })
  for (const id of [LEARNED, FRESH]) await archiveSeeded(t, id, END)
})

afterAll(async () => {
  await dropSessions(t, [LEARNED, FRESH])
  await t.db.$client.end()
})

describe('getMonedasData', () => {
  it('trae el θ que usa la cartera real: el que adoptó el aprendizaje', async () => {
    expect((await getMonedasData(LEARNED))?.theta).toBe(0.4)
  })

  it('sin aprendizaje guardado, el θ por defecto', async () => {
    expect((await getMonedasData(FRESH))?.theta).toBe(DEFAULT_SETTINGS.entry.theta)
  })
})
