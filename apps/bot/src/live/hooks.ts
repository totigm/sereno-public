// Lo que el proceso conecta al runtime en vivo además de operar (spec §8 y §9): la cola de
// replays, los retornos de las decisiones cada hora y el turno de los domingos a las 00:30
// UTC (fiabilidad de las señales y después el walk-forward de parámetros, en un worker).
// También el mmr y las comisiones de la cuenta de Binance (spec §6), si hay clave.
// Corren en el mismo programador del vivo: no hay un segundo.

import type { WalkForwardResult } from '@sereno/core/src/learning/params'
import { accountTiersJob, NO_KEY_MESSAGE, type AccountTiersDeps } from '../jobs/account-tiers'
import { forwardReturnsJob } from '../jobs/forward-returns'
import { paramTuningJob, type ParamTuningDeps } from '../jobs/param-tuning'
import { reliabilityJob } from '../jobs/reliability'
import type { Logger } from '../logger'
import type { ReplayQueue } from '../replay/queue'
import { startWorker, type WorkerDeps, type WorkerRun } from '../replay/worker'
import type { AccountHookContext, LiveHooks } from './live-types'

export interface LearningHooks {
  hooks: LiveHooks
  // Al apagar: corta un walk-forward que esté corriendo (si no, el worker retiene el proceso).
  stop(): Promise<void>
}

export interface LearningHooksDeps {
  queue: Pick<ReplayQueue, 'wake'>
  workers: WorkerDeps
  logger: Logger
  // Grilla y umbrales del walk-forward; por defecto, los de spec §8.3.
  tuning?: Pick<ParamTuningDeps, 'grid' | 'criteria'>
}

export function learningHooks({ queue, workers, logger, tuning = {} }: LearningHooksDeps): LearningHooks {
  const running = new Set<WorkerRun<WalkForwardResult>>()
  const tune: ParamTuningDeps['tune'] = async (task) => {
    const run = startWorker(workers, task)
    running.add(run)
    try {
      return await run.result
    } finally {
      running.delete(run)
    }
  }
  return {
    hooks: {
      onReplayQueued: () => queue.wake(),
      forwardReturns: async (ctx) => {
        const filled = await forwardReturnsJob(ctx)
        logger.debug({ filled }, 'Retornos de las decisiones')
      },
      weekly: async (ctx) => {
        const samples = await reliabilityJob(ctx)
        logger.info({ samples }, 'Fiabilidad semanal de las señales')
        await paramTuningJob({ ...tuning, tune, logger }, ctx)
      },
    },
    stop: async () => {
      await Promise.all([...running].map((run) => run.terminate()))
    },
  }
}

// Sin clave, el aviso sale una vez al arrancar el proceso y el trabajo no hace nada.
export function accountTiersHook(deps: AccountTiersDeps): (ctx: AccountHookContext) => Promise<void> {
  if (!deps.rest.hasKey()) deps.logger.info(NO_KEY_MESSAGE)
  return async (ctx) => {
    await accountTiersJob(deps, ctx)
  }
}
