import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Decision, LearningState } from '@sereno/core'
import type { LearningChange } from '@sereno/core/src/learning/state'
import { initialLearningState, signalRecord } from '@sereno/core/src/learning/state'
import { WALK_FORWARD_DEFAULTS, type WalkForwardResult } from '@sereno/core/src/learning/params'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { FakeBinance } from '../../src/binance/fake/server'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget } from '../../src/jobs/budget'
import { paramTuningJob } from '../../src/jobs/param-tuning'
import { reliabilityJob } from '../../src/jobs/reliability'
import type { HookContext, LearningUpdate } from '../../src/live/live-types'
import { silentLogger } from '../../src/logger'
import { computeTuning } from '../../src/replay/tuning'
import { restFor } from '../helpers/binance'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'
import { TWO_COINS } from '../helpers/live'

const SESSION = 'ses_t21_learning'
const NOW = Date.UTC(2026, 10, 1, 0, 30)
const H = 3_600_000

let t: TestDb
let fake: FakeBinance

beforeAll(async () => {
  t = await openTestDb()
  fake = await FakeBinance.start()
})

afterAll(async () => {
  await t.query('delete from sessions where id = $1', [SESSION])
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  await seedSession(t, SESSION)
  fake.reset()
})

// El contexto del hook con el motor reemplazado por un estado en memoria.
function contextWith(initial: LearningState, settings = DEFAULT_SETTINGS): { ctx: HookContext; state: () => LearningState; log: LearningChange[] } {
  let state = initial
  const log: LearningChange[] = []
  const ctx: HookContext = {
    sessionId: SESSION,
    repos: t.repos,
    now: NOW,
    settings,
    learning: () => state,
    updateLearning: async (update: (current: LearningState) => LearningUpdate) => {
      const next = update(state)
      state = next.state
      log.push(...next.log)
    },
  }
  return { ctx, state: () => state, log }
}

function decision(at: number, momentum: number): Decision {
  return {
    t: at,
    symbol: 'ETHUSDT',
    composite: {
      S: 0,
      Sprime: 0,
      confidence: 0,
      signals: [
        { id: 'momentum', value: momentum },
        { id: 'bands', value: -momentum },
      ],
      missing: [],
      weights: signalRecord(1),
      modifiers: { adx: 1, vol: 1 },
      relVolume: 1,
      higherTrendAgainst: 0,
    },
    action: { kind: 'wait' },
  }
}

describe('reliabilityJob', () => {
  it('mide Spearman contra el retorno a 4 h de las últimas 4 semanas y mueve los pesos globales', async () => {
    const at = (i: number) => NOW - 20 * 24 * H + i * H
    await t.repos.decisions.insertBatch(
      SESSION,
      Array.from({ length: 30 }, (_, i) => decision(at(i), i / 30)),
      (d) => ({ forwardReturn4h: (d.t - at(0)) / H / 1000, forwardReturn24h: null }),
    )
    // Más vieja que la ventana: no cuenta.
    await t.repos.decisions.insertBatch(SESSION, [decision(NOW - 40 * 24 * H, 1)], () => ({ forwardReturn4h: -1, forwardReturn24h: null }))
    const { ctx, state, log } = contextWith(initialLearningState(NOW - 30 * 24 * H))

    expect(await reliabilityJob(ctx)).toBe(30)
    expect(state().weightsGlobal.momentum).toBeGreaterThan(1)
    expect(state().weightsGlobal.bands).toBeLessThan(1)
    expect(log.map((c) => [c.kind, c.signal, c.sampleSize])).toEqual([
      ['weight_reliability', 'momentum', 30],
      ['weight_reliability', 'bands', 30],
    ])
  })
})

function verdict(adopt: boolean): WalkForwardResult {
  const stats = (theta: number) => ({ params: { theta, k: 1.5, tpR: 2, trailingR: 1 }, expectancyR: 0.3, se: 0.05, trades: 80, validationExpectancyR: 0.2, validationTrades: 20 })
  return {
    adopt,
    best: stats(0.45),
    current: { ...stats(0.35), expectancyR: 0.1 },
    rejected: adopt ? [] : [{ params: stats(0.45).params, expectancyR: 0.3, trades: 80, deltaR: 0.2, reason: 'worse_in_validation' }],
    criteria: { ...WALK_FORWARD_DEFAULTS },
  }
}

describe('paramTuningJob', () => {
  it('adopta la combinación aprobada y lo anota en la bitácora', async () => {
    const { ctx, state, log } = contextWith(initialLearningState(NOW - 30 * 24 * H))
    const tune = vi.fn(async () => verdict(true))

    expect(await paramTuningJob({ tune, logger: silentLogger }, ctx)).toBe('adopted')
    expect(tune).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tuning', capital: 1000, now: NOW }))
    expect(state().params).toMatchObject({ theta: 0.45, since: NOW })
    expect(log.map((c) => c.kind)).toEqual(['params'])
  })

  it('una candidata que no pasa los criterios no cambia nada pero deja el rechazo', async () => {
    const before = initialLearningState(NOW - 30 * 24 * H)
    const { ctx, state, log } = contextWith(before)

    expect(await paramTuningJob({ tune: async () => verdict(false), logger: silentLogger }, ctx)).toBe('rejected')
    expect(state().params).toEqual(before.params)
    expect(log.map((c) => c.kind)).toEqual(['params_rejected'])
  })

  it('con el ajuste apagado (o el aprendizaje congelado) ni siquiera simula', async () => {
    const off = { ...DEFAULT_SETTINGS, learning: { ...DEFAULT_SETTINGS.learning, paramTuningEnabled: false } }
    const { ctx, log } = contextWith(initialLearningState(NOW - 30 * 24 * H), off)
    const tune = vi.fn(async () => verdict(true))

    expect(await paramTuningJob({ tune, logger: silentLogger }, ctx)).toBe('skipped')
    expect(tune).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it('si mientras simulaba reiniciaron el aprendizaje, el veredicto no se aplica', async () => {
    const { ctx, state, log } = contextWith(initialLearningState(NOW - 30 * 24 * H))
    const reset = initialLearningState(NOW - H)
    const tune = async () => {
      await ctx.updateLearning(() => ({ state: reset, log: [] }))
      return verdict(true)
    }

    expect(await paramTuningJob({ tune, logger: silentLogger }, ctx)).toBe('stale')
    expect(state()).toBe(reset)
    expect(log).toEqual([])
  })
})

describe('computeTuning', () => {
  it('simula la grilla sobre los últimos 60 días del Binance falso y devuelve el veredicto', async () => {
    const learning = initialLearningState(NOW - 30 * 24 * H)
    const result = await computeTuning(
      { rest: restFor(fake, NOW).rest, repos: t.repos, budget: weightBudget(WARMUP_WEIGHT_PER_MINUTE, () => NOW), logger: silentLogger },
      { kind: 'tuning', settings: TWO_COINS, learning, capital: 1000, now: NOW, grid: [{ theta: 0.3, k: 1.5, tpR: 2, trailingR: 1 }] },
    )

    expect(result.current.params).toEqual({ theta: learning.params.theta, k: learning.params.k, tpR: learning.params.tpR, trailingR: learning.params.trailingR })
    expect(result.criteria).toEqual(WALK_FORWARD_DEFAULTS)
    expect(typeof result.adopt).toBe('boolean')
  }, 60_000)
})
