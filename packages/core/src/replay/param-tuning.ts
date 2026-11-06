import type { Settings } from '@sereno/shared'
import type { EngineFailure, Scorer } from '../engine/types'
import { PARAM_GRID, sameParams, walkForward, type ParamCombo, type WalkForwardCriteria, type WalkForwardResult } from '../learning/params'
import type { ClosedPosition, LearningState } from '../types'
import { DAY_MS } from './clock'
import { createLane } from './lane'
import type { ReplayMarket } from './market'
import { perViewScorer } from './scoring'
import { simulate } from './simulation'

// Walk-forward semanal de parámetros (spec §8.3) sobre el mercado histórico: una corrida
// por combinación, sin sombra y con los pesos congelados, todas avanzando juntas vela a
// vela para armar cada vista y calcular sus señales una sola vez (cada corrida las
// combina con sus pesos, que el encogimiento por moneda separa con los trades de cada
// una). Lo usan el replay (cuando el ajuste está prendido) y el job semanal del bot.

// Días de historia del walk-forward: optimiza en −60…−15 y valida en −15…0.
export const WALK_FORWARD_DAYS = 60
export const WALK_FORWARD_MS = WALK_FORWARD_DAYS * DAY_MS

export interface TuneParamsInput {
  market: ReplayMarket
  settings: Settings
  learning: LearningState
  capital: number
  // Ventana simulada [from, to); `to` es el "ahora" del walk-forward.
  from: number
  to: number
  grid?: readonly ParamCombo[]
  // Umbrales de adopción; por defecto los de spec §8.3 (`WALK_FORWARD_DEFAULTS`).
  criteria?: Partial<WalkForwardCriteria>
  // El mismo puntaje que la corrida que se ajusta; por defecto `computeComposite`, con
  // las señales de cada vista calculadas una vez para todas las combinaciones.
  scorer?: Scorer
  idPrefix: string
  // Con la combinación de la corrida que falló: sus trades quedan incompletos (una
  // apertura que falla depende de θ, k y el tamaño de esa combinación).
  onFailure: (failure: EngineFailure, params: ParamCombo) => void
}

export async function tuneParams(input: TuneParamsInput): Promise<WalkForwardResult> {
  const { learning } = input
  const grid = input.grid ?? PARAM_GRID
  const { theta, k, tpR, trailingR } = learning.params
  const current: ParamCombo = { theta, k, tpR, trailingR }
  const combos = [current, ...grid.filter((params) => !sameParams(params, current))]
  const scorer = input.scorer ?? perViewScorer()
  const trades = combos.map((): ClosedPosition[] => [])
  const lanes = combos.map((params, i) =>
    createLane({
      infos: input.market.infos,
      settings: input.settings,
      // Congelado: los trades de la ventana no mueven pesos ni confianza (sí cuentan).
      learning: { ...learning, frozen: true, params: { ...params, since: learning.params.since } },
      capital: input.capital,
      start: input.from,
      idPrefix: `${input.idPrefix}-${i}`,
      shadow: false,
      scorer,
      sink: (event) => {
        if (event.type === 'position_closed') trades[i]?.push(event.position)
      },
      onFailure: (failure) => input.onFailure(failure, params),
    }),
  )
  await simulate(input.market, lanes, { from: input.from, to: input.to })
  return walkForward({
    ...input.criteria,
    runFn: (params) => {
      const index = combos.findIndex((combo) => sameParams(combo, params))
      const found = trades[index]
      if (!found) throw new Error('el walk-forward pidió una combinación que no se simuló')
      return { trades: found }
    },
    current: learning.params,
    now: input.to,
    grid,
  })
}
