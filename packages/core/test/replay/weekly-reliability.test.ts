import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { initialLearningState } from '../../src/learning/state'
import { runReplay } from '../../src/replay/replay-runner'
import type { ReplayInput, ReplayProgress } from '../../src/replay/types'
import { RELIABILITY_WINDOW_MS, ReliabilityWindow } from '../../src/replay/weekly-reliability'
import type { Decision, EngineEvent, SignalResult } from '../../src/types'
import { MINI_FROM, MINI_TO, miniData } from './mini-fixture'

const M15 = 15 * 60_000
const HOUR = 3_600_000
// Domingo 4/10/2026 a las 00:30 UTC: el turno semanal.
const SUNDAY = Date.UTC(2026, 9, 4, 0, 30)

function decision(symbol: string, t: number, signals: SignalResult[]): Decision {
  return {
    t,
    symbol,
    composite: {
      S: 0,
      Sprime: 0,
      confidence: 0,
      signals,
      missing: [],
      weights: {} as Decision['composite']['weights'],
      modifiers: { adx: 1, vol: 1 },
      relVolume: 1,
      higherTrendAgainst: 0,
    },
    action: { kind: 'wait' },
  }
}

describe('ReliabilityWindow', () => {
  const now = Date.UTC(2026, 9, 4, 0, 30)
  // Cierre de cada vela de 15m: 100 + una unidad por vela desde `now − 30 días`.
  const closeAt = (_symbol: string, openTime: number) => 100 + (openTime - (now - 30 * 24 * HOUR)) / M15

  it('el retorno a 4 h es el cierre 16 velas después del de la vela que decidió', () => {
    const window = new ReliabilityWindow()
    const t = now - 10 * HOUR
    window.add(decision('BTCUSDT', t, [{ id: 'momentum', value: 0.4, detail: { rsi: 61 } }]))
    const [sample] = window.samples(now, closeAt)
    const base = closeAt('BTCUSDT', t - M15)
    expect(sample?.forwardReturn4h).toBeCloseTo((base + 16) / base - 1, 12)
    // Sólo lo que votó cada señal: el detalle no hace falta.
    expect(sample?.signals).toEqual([{ id: 'momentum', value: 0.4 }])
  })

  it('deja afuera lo que todavía no tiene 4 h, lo de antes de los 28 días y lo que no tiene velas', () => {
    const window = new ReliabilityWindow()
    window.add(decision('BTCUSDT', now - 4 * HOUR, []))
    window.add(decision('BTCUSDT', now - 4 * HOUR + M15, []))
    window.add(decision('BTCUSDT', now - RELIABILITY_WINDOW_MS - M15, []))
    window.add(decision('ETHUSDT', now - 8 * HOUR, []))
    const samples = window.samples(now, (symbol, openTime) => (symbol === 'ETHUSDT' ? null : closeAt(symbol, openTime)))
    expect(samples).toHaveLength(1)
  })
})

function miniInput(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    ...miniData(),
    id: 'mini',
    settings: DEFAULT_SETTINGS,
    learningInit: initialLearningState(MINI_FROM),
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
  const result = await runReplay(miniInput({ sink: (e) => events.push(e), ...overrides }))
  return { result, events }
}

const reliabilityChanges = (events: EngineEvent[]) => events.filter((e) => e.type === 'learning_updated' && e.kind === 'weight_reliability')

describe('runReplay — fiabilidad semanal', () => {
  it('prendida, el domingo 00:30 UTC mueve los pesos globales con lo que votó cada señal y lo registra', async () => {
    const { result, events } = await run({ reliability: true })
    const changes = reliabilityChanges(events)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((e) => e.type === 'learning_updated' && e.at === SUNDAY && e.symbol === null && e.signal !== null)).toBe(true)
    const initial = initialLearningState(MINI_FROM).weightsGlobal
    for (const change of changes) {
      if (change.type !== 'learning_updated' || !change.signal) continue
      // El tope semanal de ±0,15 vale también para esta vía.
      expect(Math.abs(result.learningFinal.weightsGlobal[change.signal] - initial[change.signal])).toBeLessThanOrEqual(0.15 + 1e-12)
    }
  })

  it('apagada (por defecto) o con el aprendizaje congelado no corre', async () => {
    expect(reliabilityChanges((await run()).events)).toEqual([])
    const frozen = await run({ reliability: true, learningInit: { ...initialLearningState(MINI_FROM), frozen: true } })
    expect(reliabilityChanges(frozen.events)).toEqual([])
  })

  it('sigue siendo determinista', async () => {
    const first = await run({ reliability: true })
    const second = await run({ reliability: true })
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result))
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events))
  })
})

describe('runReplay — progreso que espera', () => {
  it('no sigue con el día siguiente hasta que se resuelve la promesa del progreso', async () => {
    const events: EngineEvent[] = []
    const seen: { day: number; before: number; after: number }[] = []
    await runReplay(
      miniInput({
        sink: (e) => events.push(e),
        progress: async ({ day }: ReplayProgress) => {
          const before = events.length
          await new Promise((resolve) => setTimeout(resolve, 2))
          seen.push({ day, before, after: events.length })
        },
      }),
    )
    expect(seen.map((s) => s.day)).toEqual([1, 2, 3, 4, 5])
    expect(seen.every((s) => s.after === s.before)).toBe(true)
  })

  it('un error del progreso corta el replay', async () => {
    const days: number[] = []
    const failing = runReplay(
      miniInput({
        progress: ({ day }) => {
          days.push(day)
          if (day === 2) return Promise.reject(new Error('cancelado'))
          return undefined
        },
      }),
    )
    await expect(failing).rejects.toThrow('cancelado')
    expect(days).toEqual([1, 2])
  })
})
