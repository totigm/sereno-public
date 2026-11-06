import { describe, expect, it } from 'vitest'
import {
  applyWalkForward,
  PARAM_GRID,
  paramTuningBlock,
  WALK_FORWARD_DEFAULTS,
  walkForward,
  type ParamCombo,
  type WalkForwardResult,
} from '../../src/learning/params'
import { initialLearningState } from '../../src/learning/state'
import type { ClosedPosition } from '../../src/types'
import { DAY, LEARNING, T0, makeClosed } from './fixtures'

const NOW = T0 + 60 * DAY
const CURRENT = { theta: 0.35, k: 1.5, tpR: 2, trailingR: 1, since: T0 }
const CANDIDATE: ParamCombo = { theta: 0.4, k: 1.5, tpR: 2, trailingR: 1 }

// n trades con media `mean` y desvío muestral exacto `sd`: la mitad en mean + d y la
// otra mitad en mean − d, con d = sd·√((n−1)/n) para que sd(R) = sd y SE = sd/√n.
function tradesWith(n: number, mean: number, sd: number, from: number, to: number): ClosedPosition[] {
  const d = sd * Math.sqrt((n - 1) / n)
  const step = (to - from) / n
  return Array.from({ length: n }, (_, i) =>
    makeClosed({ rMultiple: mean + (i % 2 === 0 ? d : -d), openedAt: from + i * step, closedAt: from + i * step + 1 }),
  )
}

const optFrom = NOW - 60 * DAY
const optTo = NOW - 15 * DAY
const valFrom = NOW - 15 * DAY

function same(a: ParamCombo, b: ParamCombo): boolean {
  return a.theta === b.theta && a.k === b.k && a.tpR === b.tpR && a.trailingR === b.trailingR
}

describe('PARAM_GRID', () => {
  it('tiene las 162 combinaciones, con theta hasta 0,6', () => {
    expect(PARAM_GRID).toHaveLength(162)
    expect(PARAM_GRID.some((p) => same(p, { theta: 0.55, k: 2, tpR: 2, trailingR: 1 }))).toBe(true)
    expect(PARAM_GRID.some((p) => p.theta === 0.3)).toBe(false)
  })
})

describe('walkForward', () => {
  it('no adopta una combinación con 40 trades en la ventana de optimización', () => {
    // SE = 0.1 ⇒ con n = 40, sd = 0.632; mejora enorme pero muestra chica.
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(40, 1.0, 0.1 * Math.sqrt(40), optFrom, optTo), ...tradesWith(10, 1.0, 0.3, valFrom, NOW)]
        : [...tradesWith(80, 0.2, 0.1 * Math.sqrt(80), optFrom, optTo), ...tradesWith(10, 0.2, 0.3, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW })
    expect(r.adopt).toBe(false)
    expect(r.best).toBeNull()
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]?.reason).toBe('too_few_trades')
    expect(r.rejected[0]?.trades).toBe(40)
  })

  it('adopta cuando mejora 0,3R con SE 0,1 y también gana en validación', () => {
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.5, 1.0, optFrom, optTo), ...tradesWith(20, 0.5, 0.5, valFrom, NOW)]
        : [...tradesWith(100, 0.2, 1.0, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW })
    expect(r.adopt).toBe(true)
    expect(r.best?.params).toEqual(CANDIDATE)
    expect(r.best?.expectancyR).toBeCloseTo(0.5, 10)
    expect(r.best?.se).toBeCloseTo(0.1, 10)
    expect(r.best?.validationExpectancyR).toBeCloseTo(0.5, 10)
    expect(r.current.expectancyR).toBeCloseTo(0.2, 10)
    expect(r.rejected).toEqual([])
  })

  it('rechaza si la combinación vigente lleva sólo 3 días', () => {
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.5, 1.0, optFrom, optTo), ...tradesWith(20, 0.5, 0.5, valFrom, NOW)]
        : [...tradesWith(100, 0.2, 1.0, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: { ...CURRENT, since: NOW - 3 * DAY }, now: NOW })
    expect(r.adopt).toBe(false)
    expect(r.best?.params).toEqual(CANDIDATE)
    expect(r.rejected[0]?.reason).toBe('current_too_recent')
  })

  it('rechaza una mejora que no supera 2 SE aunque pase 0,1R', () => {
    // Mejora 0.15R con SE 0.1 ⇒ 0.15 < 0.2.
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.35, 1.0, optFrom, optTo), ...tradesWith(20, 0.5, 0.5, valFrom, NOW)]
        : [...tradesWith(100, 0.2, 1.0, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW })
    expect(r.adopt).toBe(false)
    expect(r.rejected[0]?.reason).toBe('not_significant')
    expect(r.rejected[0]?.deltaR).toBeCloseTo(0.15, 10)
  })

  it('rechaza una mejora significativa pero menor a 0,1R', () => {
    // Mejora 0.08R con SE 0.01 ⇒ pasa 2·SE pero no el mínimo absoluto.
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.28, 0.1, optFrom, optTo), ...tradesWith(20, 0.5, 0.5, valFrom, NOW)]
        : [...tradesWith(100, 0.2, 0.1, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW })
    expect(r.adopt).toBe(false)
    expect(r.rejected[0]?.reason).toBe('improvement_too_small')
  })

  it('rechaza si pierde en la ventana de validación', () => {
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.5, 1.0, optFrom, optTo), ...tradesWith(20, 0.1, 0.5, valFrom, NOW)]
        : [...tradesWith(100, 0.2, 1.0, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const r = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW })
    expect(r.adopt).toBe(false)
    expect(r.rejected[0]?.reason).toBe('worse_in_validation')
  })

  it('devuelve los criterios usados', () => {
    const runFn = () => ({ trades: tradesWith(100, 0.2, 1.0, optFrom, optTo) })
    expect(walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW }).criteria).toEqual(WALK_FORWARD_DEFAULTS)
    const custom = walkForward({ runFn, grid: [CANDIDATE], current: CURRENT, now: NOW, minTrades: 80, minTenureDays: 10 })
    expect(custom.criteria).toEqual({ ...WALK_FORWARD_DEFAULTS, minTrades: 80, minTenureDays: 10 })
  })

  it('elige la mejor en optimización y sólo valida a esa; la vigente no compite', () => {
    const other: ParamCombo = { theta: 0.5, k: 2, tpR: 3, trailingR: 1.5 }
    const runFn = (p: ParamCombo) => ({
      trades: same(p, CANDIDATE)
        ? [...tradesWith(100, 0.6, 1.0, optFrom, optTo), ...tradesWith(20, 0.6, 0.5, valFrom, NOW)]
        : same(p, other)
          ? [...tradesWith(100, 0.4, 1.0, optFrom, optTo), ...tradesWith(20, 0.9, 0.5, valFrom, NOW)]
          : [...tradesWith(100, 0.2, 1.0, optFrom, optTo), ...tradesWith(20, 0.2, 0.5, valFrom, NOW)],
    })
    const grid = [other, { ...CURRENT }, CANDIDATE]
    const r = walkForward({ runFn, grid, current: CURRENT, now: NOW })
    expect(r.adopt).toBe(true)
    expect(r.best?.params).toEqual(CANDIDATE)
    // La vigente no es una candidata: no figura entre las rechazadas.
    expect(r.rejected.map((x) => x.reason)).toEqual(['not_best'])
    expect(r.rejected[0]?.params).toEqual(other)
    expect(r.rejected[0]?.expectancyR).toBeCloseTo(0.4, 10)
  })

  it('corre la vigente una sola vez aunque esté en la grilla', () => {
    const calls: ParamCombo[] = []
    const runFn = (p: ParamCombo) => {
      calls.push(p)
      return { trades: tradesWith(100, 0.2, 1.0, optFrom, optTo) }
    }
    walkForward({ runFn, grid: [CANDIDATE, { ...CURRENT }], current: CURRENT, now: NOW })
    expect(calls).toHaveLength(2)
  })
})

describe('paramTuningBlock', () => {
  it('bloquea con el estado congelado, con los settings congelados o con el ajuste apagado', () => {
    const base = initialLearningState(T0)
    expect(paramTuningBlock(base, LEARNING)).toBeNull()
    expect(paramTuningBlock({ ...base, frozen: true }, LEARNING)).toBe('frozen')
    expect(paramTuningBlock(base, { ...LEARNING, frozen: true })).toBe('frozen')
    expect(paramTuningBlock(base, { ...LEARNING, paramTuningEnabled: false })).toBe('tuning_disabled')
  })
})

describe('applyWalkForward', () => {
  const result: WalkForwardResult = {
    adopt: true,
    best: { params: CANDIDATE, expectancyR: 0.5, se: 0.1, trades: 100, validationExpectancyR: 0.5, validationTrades: 20 },
    current: { params: CURRENT, expectancyR: 0.2, se: 0.1, trades: 100, validationExpectancyR: 0.2, validationTrades: 20 },
    rejected: [],
    criteria: WALK_FORWARD_DEFAULTS,
  }

  it('adopta los parámetros con since = now y lo registra', () => {
    const { state, log, skipped } = applyWalkForward(initialLearningState(T0), result, LEARNING, NOW)
    expect(skipped).toBeNull()
    expect(state.params).toEqual({ ...CANDIDATE, since: NOW })
    expect(log).toHaveLength(1)
    expect(log[0]?.kind).toBe('params')
    expect(log[0]?.sampleSize).toBe(100)
    expect(log[0]?.message).toBe(
      'Adopté θ 0,4 · k 1,5 · TP 2R · trailing 1R: +0,50R por trade contra +0,20R de la vigente (n = 100; validación +0,50R contra +0,20R).',
    )
  })

  it('si no adopta, deja los parámetros y registra el rechazo con los criterios usados', () => {
    const rejected: WalkForwardResult = {
      ...result,
      adopt: false,
      rejected: [{ params: CANDIDATE, expectancyR: 0.5, trades: 100, deltaR: 0.3, reason: 'current_too_recent' }],
      criteria: { ...WALK_FORWARD_DEFAULTS, minTenureDays: 10 },
    }
    const { state, log, skipped } = applyWalkForward(initialLearningState(T0), rejected, LEARNING, NOW)
    expect(skipped).toBeNull()
    expect(state.params.since).toBe(T0)
    expect(log[0]?.kind).toBe('params_rejected')
    expect(log[0]?.message).toBe(
      'Sigo con θ 0,35 · k 1,5 · TP 2R · trailing 1R: la mejor candidata θ 0,4 · k 1,5 · TP 2R · trailing 1R quedó +0,30R por trade respecto de la vigente y no alcanzó (la vigente lleva menos de 10 días).',
    )
  })

  it('arma los motivos con los umbrales que se usaron', () => {
    const criteria = { ...WALK_FORWARD_DEFAULTS, minTrades: 80, minImprovementR: 0.25, seMultiple: 3 }
    const reasonText = (reason: 'not_significant' | 'improvement_too_small'): string | undefined =>
      applyWalkForward(
        initialLearningState(T0),
        { ...result, adopt: false, rejected: [{ params: CANDIDATE, expectancyR: 0.5, trades: 100, deltaR: 0.3, reason }], criteria },
        LEARNING,
        NOW,
      ).log[0]?.message
    expect(reasonText('not_significant')).toContain('(la mejora no supera 3 errores estándar)')
    expect(reasonText('improvement_too_small')).toContain('(la mejora es menor a 0,25R)')
  })

  it('si ninguna candidata llegó al mínimo de trades no nombra a ninguna como la mejor', () => {
    // La vigente tiene 80 trades; cada candidata, 40.
    const few = (p: ParamCombo) => ({ trades: same(p, CURRENT) ? tradesWith(80, 0.2, 0.3, optFrom, optTo) : tradesWith(40, 1, 0.3, optFrom, optTo) })
    const wf = walkForward({ runFn: few, grid: [CANDIDATE, { ...CANDIDATE, k: 2 }], current: CURRENT, now: NOW, minTrades: 50 })
    expect(wf.best).toBeNull()
    expect(wf.rejected.map((r) => r.reason)).toEqual(['too_few_trades', 'too_few_trades'])
    const { state, log } = applyWalkForward(initialLearningState(T0), wf, LEARNING, NOW)
    expect(state.params.since).toBe(T0)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ kind: 'params_rejected', sampleSize: 0 })
    expect(log[0]?.message).toBe('Ninguna combinación llegó a 50 trades en la ventana de optimización; sigo con la vigente.')
  })

  it('un resultado que no adopta y no rechaza a su mejor candidata es inconsistente', () => {
    expect(() => applyWalkForward(initialLearningState(T0), { ...result, adopt: false, rejected: [] }, LEARNING, NOW)).toThrow(/inconsistente/)
  })

  it('con el estado congelado no adopta ni registra', () => {
    const frozen = { ...initialLearningState(T0), frozen: true }
    const { state, log, skipped } = applyWalkForward(frozen, result, LEARNING, NOW)
    expect(state).toBe(frozen)
    expect(log).toEqual([])
    expect(skipped).toBe('frozen')
  })

  it('con el aprendizaje congelado desde los settings no adopta', () => {
    const base = initialLearningState(T0)
    const { state, log, skipped } = applyWalkForward(base, result, { ...LEARNING, frozen: true }, NOW)
    expect(state).toBe(base)
    expect(state.params.since).toBe(T0)
    expect(log).toEqual([])
    expect(skipped).toBe('frozen')
  })

  it('con el ajuste de parámetros apagado no adopta', () => {
    const base = initialLearningState(T0)
    const { state, log, skipped } = applyWalkForward(base, result, { ...LEARNING, paramTuningEnabled: false }, NOW)
    expect(state).toBe(base)
    expect(log).toEqual([])
    expect(skipped).toBe('tuning_disabled')
  })
})
