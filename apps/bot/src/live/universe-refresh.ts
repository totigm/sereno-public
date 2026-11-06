// Contratos y universo del día (spec §5.1 y §12): `symbols` desde exchangeInfo y después
// el universo con las abiertas de la sesión.

import type { Repos, SymbolRecord } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { BinanceRest } from '../binance/rest'
import { refreshSymbols } from '../jobs/symbols'
import { computeUniverse } from '../jobs/universe'
import type { Logger } from '../logger'

export interface UniverseDeps {
  rest: Pick<BinanceRest, 'exchangeInfo' | 'fundingInfo' | 'ticker24h'>
  repos: Repos
  logger: Logger
}

export interface Universe {
  // Fijadas, top por volumen y las abiertas que quedaron afuera del top.
  symbols: string[]
  // Abiertas cuyo contrato desapareció: el motor las cierra.
  delisted: string[]
}

export interface RefreshedUniverse {
  universe: Universe
  records: SymbolRecord[]
}

export interface UniverseInput {
  sessionId: string
  settings: Settings
  openSymbols: readonly string[]
  now: number
}

// Cómo arma su universo cada sesión: la de papel con `refreshUniverse`; la real de testnet,
// además, contra los contratos de testnet (`real/universe.ts`).
export type UniverseRefresh = (input: UniverseInput) => Promise<RefreshedUniverse>

export async function refreshUniverse(deps: UniverseDeps, input: UniverseInput): Promise<RefreshedUniverse> {
  const { rest, repos, logger } = deps
  const { contracts } = await refreshSymbols({ rest, repos, logger }, input.settings.risk)
  const computed = await computeUniverse(
    { rest, repos: { symbols: repos.symbols, universeDays: repos.universeDays }, logger },
    { sessionId: input.sessionId, contracts, settings: input.settings.universe, openSymbols: input.openSymbols, today: input.now },
  )
  return { universe: { symbols: computed.symbols, delisted: computed.delisted }, records: await repos.symbols.all() }
}
