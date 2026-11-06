import type { Db } from '../client'
import { createBotRepo } from './bot'
import { createCandlesRepo } from './candles'
import { createCommandsRepo } from './commands'
import { createDecisionsRepo } from './decisions'
import { createEquityRepo } from './equity'
import { createFuturesRepo } from './futures'
import { createLearningRepo } from './learning'
import { createMarketRepo } from './market'
import { createPositionsRepo } from './positions'
import { createRealEventsRepo, createRealReadinessRepo } from './real'
import { createSessionsRepo } from './sessions'
import { createSettingsRepo } from './settings'
import { createSymbolsRepo } from './symbols'
import { createUniverseDaysRepo } from './universe-days'

export * from './bot'
export * from './candles'
export * from './commands'
export * from './decisions'
export * from './equity'
export * from './errors'
export * from './futures'
export * from './learning'
export * from './market'
export * from './positions'
export * from './real'
export * from './sessions'
export * from './settings'
export * from './symbols'
export * from './universe-days'
export type { ClosedPositionRecord, PositionRecord } from './position-rows'
export type { ArchiveClose } from './archive-close'

// Todos los repositorios sobre un mismo cliente. Con una transacción
// (`db.transaction((tx) => createRepos(tx)…)`) varias escrituras van juntas.
export function createRepos(db: Db) {
  return {
    sessions: createSessionsRepo(db),
    settings: createSettingsRepo(db),
    symbols: createSymbolsRepo(db),
    universeDays: createUniverseDaysRepo(db),
    positions: createPositionsRepo(db),
    decisions: createDecisionsRepo(db),
    equity: createEquityRepo(db),
    market: createMarketRepo(db),
    candles: createCandlesRepo(db),
    futures: createFuturesRepo(db),
    learning: createLearningRepo(db),
    bot: createBotRepo(db),
    commands: createCommandsRepo(db),
    realReadiness: createRealReadinessRepo(db),
    realEvents: createRealEventsRepo(db),
  }
}

export type Repos = ReturnType<typeof createRepos>
