import { describe, expect, it } from 'vitest'
import type { LearningState } from '@sereno/core'
import { initialLearningState, signalRecord, weekStartOf } from '@sereno/core/src/learning/state'
import type { Repos, SessionRow } from '@sereno/db'
import { replayLearning } from '../../src/replay/learning-init'

const DAY = 86_400_000
// El replay pide los 90 días que terminan el 31 de octubre; el vivo aprendió hasta hoy.
const NOW = Date.UTC(2026, 9, 31, 12)
const FROM = Date.UTC(2026, 7, 2)

function learned(): LearningState {
  return {
    ...initialLearningState(NOW - 20 * DAY),
    weightsGlobal: { ...signalRecord(1), momentum: 1.3, bands: 0.7 },
    weightsBySymbol: { ETHUSDT: { momentum: 1.1 } },
    weeklyDelta: { ...signalRecord(0), momentum: 0.04 },
    weekStart: weekStartOf(NOW),
    confidenceBySymbol: { ETHUSDT: 0.8 },
    tradesBySymbol: { ETHUSDT: 12 },
    // Vence dentro de dos días: en el replay bloquearía ETH todo el período.
    penalties: { ETHUSDT: NOW + 2 * DAY },
    params: { theta: 0.42, k: 1.8, tpR: 2.5, trailingR: 1.2, since: NOW - 3 * DAY },
    closedTrades: 40,
    version: 17,
  }
}

function reposWith(live: Pick<SessionRow, 'id'> | null, state: LearningState | null): Pick<Repos, 'sessions' | 'learning'> {
  return {
    sessions: { getActive: async (kind: string) => (kind === 'paper_live' ? live : null) },
    learning: { get: async (id: string) => (live && id === live.id ? state : null) },
  } as unknown as Pick<Repos, 'sessions' | 'learning'>
}

describe('replayLearning', () => {
  it('desde cero: el estado inicial al comienzo del período', async () => {
    const result = await replayLearning(reposWith({ id: 'ses_live' }, learned()), 'zero', FROM)

    expect(result.state).toEqual(initialLearningState(FROM))
    expect(result.origin).toEqual({ origin: 'zero', fromSessionId: null })
  })

  it('con el vigente: sigue con pesos, confianza y parámetros del vivo, llevados al inicio del período', async () => {
    const current = learned()
    const result = await replayLearning(reposWith({ id: 'ses_live' }, current), 'current', FROM)

    expect(result.origin).toEqual({ origin: 'continued', fromSessionId: 'ses_live' })
    expect(result.state).toEqual({
      ...current,
      // Lo fechado en el tiempo del vivo no viaja: el tope semanal arranca la semana de
      // `from`, las penitencias no bloquean monedas todo el período y los parámetros
      // cuentan desde `from`.
      weekStart: weekStartOf(FROM),
      weeklyDelta: signalRecord(0),
      penalties: {},
      params: { ...current.params, since: FROM },
    })
    // No toca el estado del vivo.
    expect(current.penalties).toEqual({ ETHUSDT: NOW + 2 * DAY })
  })

  it('con el vigente pero sin simulación en vivo, o sin nada aprendido todavía, arranca de cero', async () => {
    for (const repos of [reposWith(null, null), reposWith({ id: 'ses_live' }, null)]) {
      const result = await replayLearning(repos, 'current', FROM)
      expect(result.state).toEqual(initialLearningState(FROM))
      expect(result.origin).toEqual({ origin: 'zero', fromSessionId: null })
    }
  })
})
