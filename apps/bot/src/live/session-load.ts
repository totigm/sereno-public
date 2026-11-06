// Al tomar una sesión: ajustes, aprendizaje, contratos y universo del día, y el motor
// retomado desde la base (abiertas, saldo, blindaje, cortes de cuenta).

import type { EngineEvent, LearningState, SymbolInfo } from '@sereno/core'
import type { TradingEngine } from '@sereno/core/src/engine/engine'
import type { EngineFailure, Scorer } from '@sereno/core/src/engine/types'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { BotFlags, Repos, SessionRow, SymbolRecord } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { Logger } from '../logger'
import type { EngineBuild } from './engine-build'
import { infosFrom } from './infos'
import { planRestore } from './restore'
import { loadRestoreInput } from './restore-load'
import type { Universe, UniverseRefresh } from './universe-refresh'

export interface LoadedSession {
  settings: Settings
  settingsVersion: number
  learning: LearningState
  universe: Universe
  records: SymbolRecord[]
  infos: Record<string, SymbolInfo>
  engine: TradingEngine
}

// Lo que ya se sabe antes de leer las abiertas de la base.
export interface RestoreContext {
  settings: Settings
  infos: Record<string, SymbolInfo>
  now: number
}

export interface LoadDeps {
  repos: Repos
  logger: Logger
  refreshUniverse: UniverseRefresh
  buildEngine: (b: EngineBuild) => Promise<TradingEngine>
  // Antes de leer las abiertas: la real reconcilia con Binance y deja en la base lo que adopta.
  beforeRestore?: (ctx: RestoreContext) => Promise<void>
  now: () => number
  sink: (event: EngineEvent) => void
  onFailure: (failure: EngineFailure) => void
  // Los cortes del último latido guardado (la pausa por drawdown se retoma de ahí).
  lastFlags: BotFlags | null
  scorer?: Scorer
}

export async function loadSession(deps: LoadDeps, row: SessionRow): Promise<LoadedSession> {
  const { repos } = deps
  const now = deps.now()
  const settingsRow = await repos.settings.get(row.id)
  if (!settingsRow) throw new Error(`La sesión ${row.id} no tiene ajustes`)
  const settings = settingsRow.config
  const learning = (await repos.learning.get(row.id)) ?? initialLearningState(now)
  const open = [...(await repos.positions.listOpen(row.id)), ...(await repos.positions.listOpen(row.id, { shadow: true }))]
  const openSymbols = [...new Set(open.map((p) => p.symbol))]
  const { universe, records } = await deps.refreshUniverse({ sessionId: row.id, settings, openSymbols, now })
  const infos = infosFrom(records, settings.risk)
  await deps.beforeRestore?.({ settings, infos, now })
  const input = await loadRestoreInput(repos, {
    session: row,
    settings,
    settingsVersion: settingsRow.version,
    lastFlags: deps.lastFlags,
    tickSize: (symbol) => infos[symbol]?.tickSize ?? 0,
    now,
  })
  const engine = await deps.buildEngine({
    sessionId: row.id,
    capitalInicial: row.capitalInicial,
    settings,
    learning,
    plan: planRestore(input),
    infos,
    clock: deps.now,
    sink: deps.sink,
    onFailure: deps.onFailure,
    logger: deps.logger,
    ...(deps.scorer ? { scorer: deps.scorer } : {}),
  })
  return { settings, settingsVersion: settingsRow.version, learning, universe, records, infos, engine }
}
