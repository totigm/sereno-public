// Ajuste semanal de parámetros del vivo (spec §8.3), los domingos a las 00:30 UTC después
// de la fiabilidad: walk-forward de los últimos 60 días (en un worker, ver
// `replay/tuning.ts`). Sólo se adopta la combinación que pasa los criterios; la adopción o
// el rechazo de la mejor candidata quedan en `learning_log` y en el diario.

import type { ParamCombo, WalkForwardCriteria, WalkForwardResult } from '@sereno/core/src/learning/params'
import { applyWalkForward, paramTuningBlock } from '@sereno/core/src/learning/params'
import type { HookContext } from '../live/live-types'
import type { Logger } from '../logger'
import type { TuningTask } from '../replay/tuning'

export interface ParamTuningDeps {
  // Corre el walk-forward; en el bot, en un worker.
  tune: (task: TuningTask) => Promise<WalkForwardResult>
  logger: Logger
  grid?: ParamCombo[]
  criteria?: Partial<WalkForwardCriteria>
}

export type ParamTuningOutcome = 'skipped' | 'adopted' | 'rejected' | 'stale'

export async function paramTuningJob(deps: ParamTuningDeps, ctx: HookContext): Promise<ParamTuningOutcome> {
  const { logger } = deps
  const learning = ctx.learning()
  const blocked = paramTuningBlock(learning, ctx.settings.learning)
  if (blocked !== null) {
    logger.info({ reason: blocked }, 'Ajuste semanal de parámetros: no corre')
    return 'skipped'
  }
  const session = await ctx.repos.sessions.get(ctx.sessionId)
  if (!session) throw new Error(`No encontré la sesión ${ctx.sessionId}`)
  const result = await deps.tune({
    kind: 'tuning',
    settings: ctx.settings,
    learning,
    capital: session.capitalInicial,
    now: ctx.now,
    ...(deps.grid ? { grid: deps.grid } : {}),
    ...(deps.criteria ? { criteria: deps.criteria } : {}),
  })
  let outcome: ParamTuningOutcome = 'stale'
  await ctx.updateLearning((current) => {
    // Si mientras corría cambiaron los parámetros (reiniciaron el aprendizaje), el
    // veredicto es sobre otros: no se aplica.
    if (current.params.since !== learning.params.since) return { state: current, log: [] }
    const applied = applyWalkForward(current, result, ctx.settings.learning, ctx.now)
    outcome = applied.skipped !== null ? 'skipped' : result.adopt ? 'adopted' : 'rejected'
    return applied
  })
  logger.info({ outcome, best: result.best?.params ?? null }, 'Ajuste semanal de parámetros')
  return outcome
}
