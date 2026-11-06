// El walk-forward semanal de parámetros del vivo (spec §8.3), del lado del worker: baja (o
// reutiliza) los últimos 60 días como un replay y simula todas las combinaciones juntas,
// en memoria, con señales calculadas una vez, pesos congelados y sin sombra. Devuelve
// sólo el veredicto; aplicarlo es del job, sobre el aprendizaje vigente del motor.

import type { LearningState } from '@sereno/core'
import type { ParamCombo, WalkForwardCriteria, WalkForwardResult } from '@sereno/core/src/learning/params'
import { ReplayMarket } from '@sereno/core/src/replay/market'
import { tuneParams, WALK_FORWARD_DAYS } from '@sereno/core/src/replay/param-tuning'
import type { Settings } from '@sereno/shared'
import { errorMessage } from '../jobs/errors'
import { downloadReplayData, type DownloadDeps } from './download'
import { trailingPeriod } from './period'

export interface TuningTask {
  kind: 'tuning'
  settings: Settings
  learning: LearningState
  capital: number
  now: number
  // Por defecto la grilla de 135 combinaciones y los umbrales de spec §8.3.
  grid?: ParamCombo[]
  criteria?: Partial<WalkForwardCriteria>
}

export async function computeTuning(deps: DownloadDeps, task: TuningTask): Promise<WalkForwardResult> {
  const period = trailingPeriod(WALK_FORWARD_DAYS, task.now)
  // La pausa es del vivo: el walk-forward mide qué habría pasado operando.
  const settings: Settings = { ...task.settings, pause: { paused: false, by: null, at: null, reason: null } }
  const { data } = await downloadReplayData(deps, { period, now: task.now, settings }, async () => undefined, { compact: true })
  let failures = 0
  const result = await tuneParams({
    market: new ReplayMarket(data),
    settings,
    learning: task.learning,
    capital: task.capital,
    from: period.from,
    to: period.to,
    ...(task.grid ? { grid: task.grid } : {}),
    ...(task.criteria ? { criteria: task.criteria } : {}),
    idPrefix: `wf-${task.now}`,
    onFailure: (failure) => {
      failures += 1
      if (failures === 1) deps.logger.warn({ symbol: failure.symbol, err: errorMessage(failure.error) }, 'Ajuste semanal: el motor salteó una operación')
    },
  })
  deps.logger.info({ adopt: result.adopt, best: result.best?.params ?? null, failures }, 'Ajuste semanal: walk-forward terminado')
  return result
}
