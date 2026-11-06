import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LearningState } from '@sereno/core'
import type { LearningChange } from '@sereno/core/src/learning/state'
import { initialLearningState } from '@sereno/core/src/learning/state'
import { FakeBinance } from '../../src/binance/fake/server'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../../src/jobs/budget'
import { learningHooks } from '../../src/live/hooks'
import type { HookContext, LearningUpdate } from '../../src/live/live-types'
import { silentLogger } from '../../src/logger'
import { restFor } from '../helpers/binance'
import { openTestDb, seedSession, TEST_URL, type TestDb } from '../helpers/db'
import { TWO_COINS } from '../helpers/live'

const SESSION = 'ses_t21_hooks'
// Domingo 1 de noviembre, 00:30 UTC: el turno semanal.
const NOW = Date.UTC(2026, 10, 1, 0, 30)
const DAY = 86_400_000

let t: TestDb
let fake: FakeBinance

beforeAll(async () => {
  t = await openTestDb()
  fake = await FakeBinance.start()
  await seedSession(t, SESSION)
})

afterAll(async () => {
  await t.query('delete from sessions where id = $1', [SESSION])
  await fake.stop()
  await t.close()
})

describe('learningHooks', () => {
  it('el turno de los domingos corre el walk-forward en un worker real y aplica su veredicto al aprendizaje del vivo', async () => {
    const wake = vi.fn()
    const learning = learningHooks({
      queue: { wake },
      workers: { rest: restFor(fake, NOW).rest, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW), logger: silentLogger, databaseUrl: TEST_URL },
      logger: silentLogger,
      // Una combinación y un mínimo de trades inalcanzable: el veredicto es siempre el mismo.
      tuning: { grid: [{ theta: 0.3, k: 1.5, tpR: 2, trailingR: 1 }], criteria: { minTrades: 1_000_000 } },
    })
    let state: LearningState = initialLearningState(NOW - 30 * DAY)
    const log: LearningChange[] = []
    const ctx: HookContext = {
      sessionId: SESSION,
      repos: t.repos,
      now: NOW,
      settings: TWO_COINS,
      learning: () => state,
      updateLearning: async (update: (current: LearningState) => LearningUpdate) => {
        const next = update(state)
        state = next.state
        log.push(...next.log)
      },
    }

    await learning.hooks.weekly!(ctx)
    await learning.stop()

    expect(log.filter((c) => c.kind.startsWith('params')).map((c) => [c.kind, c.message])).toEqual([
      ['params_rejected', 'Ninguna combinación llegó a 1000000 trades en la ventana de optimización; sigo con la vigente.'],
    ])
    learning.hooks.onReplayQueued?.('ses_x')
    expect(wake).toHaveBeenCalled()
  }, 60_000)
})
