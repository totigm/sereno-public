import { DEFAULT_SETTINGS } from '@sereno/shared'
import { scenarioLearningState } from '../engine/fixtures'
import { describe, expect, it } from 'vitest'
import { runReplay } from '../../src/replay/replay-runner'
import type { ReplayInput, ReplayProgress } from '../../src/replay/types'
import { computeStats } from '../../src/stats/stats'
import type { EngineEvent } from '../../src/types'
import { BAD_FUNDING_AT, MINI_FROM, MINI_TO, miniData, miniDataWithBadFunding } from './mini-fixture'

// El replay sobre el fixture mini (2 símbolos, 5 días, señales reales).

const DAY = 86_400_000
// Domingo 4/10/2026 a las 00:30 UTC: el ajuste semanal de parámetros.
const SUNDAY_TUNING = Date.UTC(2026, 9, 4, 0, 30)
const TWO_COMBOS = [
  { theta: 0.3, k: 1.5, tpR: 2, trailingR: 1 },
  { theta: 0.45, k: 2, tpR: 3, trailingR: 1.5 },
]

function miniInput(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    ...miniData(),
    id: 'mini',
    settings: DEFAULT_SETTINGS,
    learningInit: scenarioLearningState(MINI_FROM),
    capital: 1_000,
    from: MINI_FROM,
    to: MINI_TO,
    paramTuning: false,
    sink: () => undefined,
    ...overrides,
  }
}

async function run(overrides: Partial<ReplayInput> = {}) {
  const events: EngineEvent[] = []
  const progress: ReplayProgress[] = []
  const onProgress = (p: ReplayProgress): void => {
    progress.push(p)
  }
  const result = await runReplay(miniInput({ sink: (e) => events.push(e), progress: onProgress, ...overrides }))
  return { result, events, progress }
}

describe('runReplay — determinismo', () => {
  it('el mismo input da el mismo resultado y los mismos eventos, byte a byte', async () => {
    const first = await run()
    const second = await run()
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result))
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events))
    // Que el test valga algo: hubo trades de las dos carteras, funding y trailing.
    expect(first.result.closed.real.length).toBeGreaterThan(5)
    // La sombra decide con θ 0,55: sobre estos 5 días de datos reales opera menos que lo real.
    expect(first.result.closed.shadow.length).toBeGreaterThan(0)
    expect(first.events.some((e) => e.type === 'funding_applied')).toBe(true)
    expect(first.events.some((e) => e.type === 'stop_moved')).toBe(true)
  })
})

describe('runReplay — resultado', () => {
  it('separa lo real de la sombra en trades, abiertas, equity y estadísticas, y las compara', async () => {
    const { result } = await run()
    const { closed, open, stats, equity, shadowComparison } = result
    expect(closed.real.every((c) => !c.shadow)).toBe(true)
    expect(closed.shadow.every((c) => c.shadow)).toBe(true)
    expect([...open.real.map((p) => p.shadow), ...open.shadow.map((p) => !p.shadow)]).not.toContain(true)
    expect(stats.real.trades).toBe(closed.real.length)
    expect(stats.shadow.trades).toBe(closed.shadow.length)
    expect(() => computeStats([...closed.real, ...closed.shadow], [])).toThrow(RangeError)
    // Una equity al inicio y una por vela de 15m del período.
    expect(equity).toHaveLength(1 + (MINI_TO - MINI_FROM) / (15 * 60_000))
    expect(equity[0]).toMatchObject({ at: MINI_FROM, real: { equity: 1_000 }, shadow: { equity: 1_000 } })
    expect(shadowComparison).toMatchObject({ from: MINI_FROM, to: MINI_TO, tradesLearned: closed.real.length, tradesShadow: closed.shadow.length })
    const lastEquity = equity.at(-1)
    expect(shadowComparison.learnedPp).toBeCloseTo((((lastEquity?.real.equity ?? 0) - 1_000) / 1_000) * 100, 9)
  })

  it('las posiciones llevan el prefijo del replay y el resultado no tiene fallas', async () => {
    const { result } = await run()
    expect(result.closed.real.every((c) => c.id.startsWith('replay-mini-real-'))).toBe(true)
    expect(result.closed.shadow.every((c) => c.id.startsWith('replay-mini-shadow-'))).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('informa el progreso una vez por día simulado', async () => {
    const { progress } = await run()
    expect(progress).toEqual([1, 2, 3, 4, 5].map((day) => ({ day, of: 5 })))
  })

  it('decide al cierre de cada vela de 15m, en todas las monedas del universo del día', async () => {
    const { result } = await run()
    const slots = (MINI_TO - MINI_FROM) / (15 * 60_000)
    const times = [...new Set(result.decisions.map((d) => d.t))]
    expect(times).toHaveLength(slots)
    expect(times[0]).toBe(MINI_FROM)
    expect(Object.keys(result.universeByDay)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
    // El día 4 el universo es sólo ETH; BTC aparece únicamente si tenía una abierta.
    expect(result.universeByDay['2026-10-04']?.[0]).toBe('ETHUSDT')
  })

  it('el histograma cuenta cada decisión con vela y la correlación es simétrica con diagonal 1', async () => {
    const { result } = await run()
    const withCandle = result.decisions.filter((d) => !(d.action.kind === 'blocked' && d.action.reason === 'no_candle'))
    expect(result.signalHistogram.reduce((acc, bin) => acc + bin.count, 0)).toBe(withCandle.length)
    const { rho, signals } = result.correlation
    signals.forEach((_, i) => {
      expect([1, null]).toContain(rho[i]?.[i])
      signals.forEach((__, j) => expect(rho[i]?.[j]).toBe(rho[j]?.[i]))
    })
  })

  it('sin guardar las decisiones, el resto del resultado sale igual (el reporte se arma sobre la marcha)', async () => {
    const kept = await run()
    const dropped = await run({ keepDecisions: false })
    expect(kept.result.decisions.length).toBeGreaterThan(0)
    expect(dropped.result.decisions).toEqual([])
    expect({ ...dropped.result, decisions: kept.result.decisions }).toEqual(kept.result)
    // El sink recibe las decisiones igual: es por donde se guardan.
    expect(dropped.events).toEqual(kept.events)
  })

  it('las señales sin datos quedan listadas con sus fechas (OI llega recién el tercer día)', async () => {
    const { result } = await run()
    const oi = result.missingSignalWindows.filter((w) => w.signal === 'openInterest')
    expect(oi.map((w) => w.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(oi.every((w) => w.from === MINI_FROM)).toBe(true)
  })
})

describe('runReplay — aprendizaje', () => {
  it('arranca con el aprendizaje que recibe y devuelve el final', async () => {
    const learningInit = { ...scenarioLearningState(MINI_FROM), confidenceBySymbol: { ETHUSDT: -0.3 } }
    const { result } = await run({ learningInit })
    // Confianza −0,3 en ETH ⇒ mMoneda 0,7 en el tamaño de lo real (la sombra no lo usa).
    const firstEth = result.decisions.find((d) => d.symbol === 'ETHUSDT' && d.action.kind === 'enter')
    expect(firstEth?.action.kind === 'enter' && firstEth.action.plan.multipliers.symbol).toBe(0.7)
    expect(result.learningFinal.closedTrades).toBe(result.closed.real.length)
    expect(result.learningFinal.tradesBySymbol['ETHUSDT']).toBeGreaterThan(0)
  })

  it('con el ajuste de parámetros prendido corre el walk-forward del domingo 00:30 UTC; apagado, no', async () => {
    const off = await run({ paramGrid: TWO_COMBOS })
    const on = await run({ paramTuning: true, paramGrid: TWO_COMBOS })
    const params = (events: EngineEvent[]) => events.filter((e) => e.type === 'learning_updated' && (e.kind === 'params' || e.kind === 'params_rejected'))
    expect(params(off.events)).toEqual([])
    // Con 3 días de historia ninguna combinación llega a 60 trades: se rechaza y lo dice.
    expect(params(on.events)).toEqual([expect.objectContaining({ kind: 'params_rejected', at: SUNDAY_TUNING })])
    // Sin adopción el aprendizaje no cambia: los trades son los mismos.
    expect(on.result.closed).toEqual(off.result.closed)
  })

  it('una falla de datos del ajuste llega una sola vez por domingo, con la primera combinación y cuántas veces pasó', async () => {
    const { result } = await run({ ...miniDataWithBadFunding(), paramTuning: true, paramGrid: TWO_COMBOS })
    const { theta, k, tpR, trailingR } = scenarioLearningState(MINI_FROM).params
    const summary = result.failures.map((f) => ({
      operation: f.operation,
      at: f.at,
      tuning: 'tuning' in f ? f.tuning : undefined,
      count: 'count' in f ? f.count : undefined,
    }))
    // Primero la de la corrida principal (sin `tuning`) y el domingo una sola por las tres
    // corridas (la vigente más las dos de la grilla): el funding inválido no depende de los parámetros.
    expect(summary).toEqual([
      { operation: 'funding', at: BAD_FUNDING_AT, tuning: undefined, count: undefined },
      { operation: 'funding', at: BAD_FUNDING_AT, tuning: { at: SUNDAY_TUNING, params: { theta, k, tpR, trailingR } }, count: 3 },
    ])
    expect(result.failures[0]).not.toHaveProperty('tuning')
    expect(result.failures[0]).not.toHaveProperty('count')
  })

  it('con el aprendizaje congelado el ajuste no corre', async () => {
    const { events } = await run({ paramTuning: true, paramGrid: TWO_COMBOS, learningInit: { ...scenarioLearningState(MINI_FROM), frozen: true } })
    expect(events.some((e) => e.type === 'learning_updated' && e.kind === 'params_rejected')).toBe(false)
  })
})

describe('runReplay — validación', () => {
  it('rechaza un período desalineado, vacío o sin universo para algún día', async () => {
    await expect(runReplay(miniInput({ from: MINI_FROM + 1 }))).rejects.toThrow(RangeError)
    await expect(runReplay(miniInput({ to: MINI_FROM }))).rejects.toThrow(RangeError)
    await expect(runReplay(miniInput({ to: MINI_TO + DAY }))).rejects.toThrow(/sin universo/)
    await expect(runReplay(miniInput({ id: '' }))).rejects.toThrow(RangeError)
  })

  it('rechaza un universo con una moneda sin velas', async () => {
    const data = miniData()
    await expect(runReplay(miniInput({ symbolsByDay: { ...data.symbolsByDay, '2026-10-02': ['XRPUSDT'] } }))).rejects.toThrow(/XRPUSDT/)
  })
})
