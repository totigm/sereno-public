import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { sameParams, type ParamCombo, type ParamStats, type WalkForwardResult } from '../../src/learning/params'
import { initialLearningState } from '../../src/learning/state'
import { ReplayMarket } from '../../src/replay/market'
import { tuneParams, type TuneParamsInput } from '../../src/replay/param-tuning'
import type { ReplayData } from '../../src/replay/types'
import { BAD_FUNDING_AT, MINI_FROM, MINI_TO, miniData, miniDataWithBadFunding } from './mini-fixture'

// El walk-forward corre una simulación por combinación, todas juntas vela a vela.

const LOOSE: ParamCombo = { theta: 0.3, k: 1, tpR: 1.5, trailingR: 0.75 }
const STRICT: ParamCombo = { theta: 0.45, k: 2, tpR: 3, trailingR: 1.5 }

async function tune(grid: readonly ParamCombo[], data: ReplayData = miniData(), onFailure?: TuneParamsInput['onFailure']): Promise<WalkForwardResult> {
  return tuneParams({
    market: new ReplayMarket(data),
    settings: DEFAULT_SETTINGS,
    learning: initialLearningState(MINI_FROM),
    capital: 1_000,
    from: MINI_FROM,
    to: MINI_TO,
    grid,
    // Con 5 días de datos: valida en los últimos 2 y optimiza en los 3 primeros.
    criteria: { validationDays: 2 },
    idPrefix: 'wf',
    onFailure:
      onFailure ??
      ((f) => {
        throw f.error
      }),
  })
}

function statsOf(result: WalkForwardResult, params: ParamCombo): Pick<ParamStats, 'expectancyR' | 'trades'> {
  const found = result.rejected.find((r) => sameParams(r.params, params))
  if (!found) throw new Error('la combinación no figura entre las rechazadas')
  return { expectancyR: found.expectancyR, trades: found.trades }
}

describe('tuneParams', () => {
  it('las combinaciones que corren juntas no se mezclan: cada una da lo mismo que corrida sola', async () => {
    const together = await tune([LOOSE, STRICT])
    const loose = await tune([LOOSE])
    const strict = await tune([STRICT])
    expect(together.current).toEqual(loose.current)
    expect(together.current).toEqual(strict.current)
    expect(statsOf(together, LOOSE)).toEqual(statsOf(loose, LOOSE))
    expect(statsOf(together, STRICT)).toEqual(statsOf(strict, STRICT))
  })

  it('cada combinación opera con sus parámetros: un θ más bajo opera más que uno más alto', async () => {
    const result = await tune([LOOSE, STRICT])
    expect(result.current.trades).toBeGreaterThan(0)
    expect(statsOf(result, LOOSE).trades).toBeGreaterThan(statsOf(result, STRICT).trades)
    // Nada llega a 60 trades en la ventana de optimización: no se adopta.
    expect(result.adopt).toBe(false)
  })

  it('avisa las fallas de cada corrida con la combinación que simulaba', async () => {
    const failures: { operation: string; at: number; params: ParamCombo }[] = []
    await tune([LOOSE, STRICT], miniDataWithBadFunding(), (f, params) => failures.push({ operation: f.operation, at: f.at, params }))
    const { theta, k, tpR, trailingR } = initialLearningState(MINI_FROM).params
    // La vigente corre primero y después la grilla, cada una en su motor.
    expect(failures).toEqual([{ theta, k, tpR, trailingR }, LOOSE, STRICT].map((params) => ({ operation: 'funding', at: BAD_FUNDING_AT, params })))
  })
})
