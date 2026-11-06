// Universo del día (spec §5.1): volumen de 24 h de `ticker/24hr` (una llamada de peso
// 40), `selectUniverse` con las abiertas y el snapshot en `universe_days` con ranking
// por volumen, mínimos de cada contrato, por qué sigue cada abierta que hoy no entraría
// y por qué quedó afuera cada moneda que no pasó un filtro.

import type { ContractMeta } from '@sereno/core'
import { utcDay } from '@sereno/core/src/replay/clock'
import { selectUniverse, type SelectUniverseResult } from '@sereno/core/src/universe/select-universe'
import type { SymbolRecord, SymbolsRepo, UniverseDayEntry, UniverseDaysRepo, UniverseExcluded } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { BinanceRest } from '../binance/rest'
import type { Logger } from '../logger'
import { universeSnapshot, type ContractFilters } from './universe-snapshot'

export interface ComputeUniverseDeps {
  rest: Pick<BinanceRest, 'ticker24h'>
  repos: { symbols: Pick<SymbolsRepo, 'all'>; universeDays: Pick<UniverseDaysRepo, 'upsertDay'> }
  logger: Logger
}

export interface ComputeUniverseInput {
  sessionId: string
  // Los de `refreshSymbols` del mismo ciclo: universo y `symbols` salen del mismo exchangeInfo.
  contracts: readonly ContractMeta[]
  settings: Settings['universe']
  openSymbols: readonly string[]
  // Instante (ms UTC) dentro del día que se selecciona.
  today: number
}

export interface ComputedUniverse extends SelectUniverseResult {
  day: string
  entries: UniverseDayEntry[]
  excluded: UniverseExcluded
}

export async function computeUniverse({ rest, repos, logger }: ComputeUniverseDeps, input: ComputeUniverseInput): Promise<ComputedUniverse> {
  const { sessionId, contracts, settings, openSymbols, today } = input
  const tickers = await rest.ticker24h()
  const volumes = Object.fromEntries(tickers.map((t) => [t.symbol, t.quoteVolume]))
  const result = selectUniverse({ contracts: [...contracts], volumes, today, settings, openSymbols: [...openSymbols] })

  const delistedFilters = new Map<string, ContractFilters>()
  for (const [symbol, record] of await delistedRecords(repos.symbols, result.delisted)) delistedFilters.set(symbol, filtersOf(record))
  const missing = result.delisted.filter((symbol) => !delistedFilters.has(symbol))
  if (missing.length > 0) logger.warn({ symbols: missing }, 'Universo: abiertas deslistadas sin fila en symbols, se guardan con mínimos en cero')

  const { entries, excluded } = universeSnapshot(result, { contracts, volumes, pinned: settings.pinned, delistedFilters })
  const day = utcDay(today)
  await repos.universeDays.upsertDay(sessionId, { day, symbols: entries, excluded })
  logger.info(
    { day, size: entries.length, keptOpen: result.keptOpen, delisted: result.delisted, pinnedExcluded: result.pinnedExcluded },
    'Universo del día calculado',
  )
  return { ...result, day, entries, excluded }
}

// Sólo se lee `symbols` si hay deslistadas: es el último snapshot conocido de su contrato.
async function delistedRecords(symbols: Pick<SymbolsRepo, 'all'>, delisted: readonly string[]): Promise<Map<string, SymbolRecord>> {
  if (delisted.length === 0) return new Map()
  const wanted = new Set(delisted)
  return new Map((await symbols.all()).filter((r) => wanted.has(r.symbol)).map((r) => [r.symbol, r]))
}

function filtersOf(r: SymbolRecord): ContractFilters {
  return { minNotional: r.minNotional, minQty: r.minQty, stepSize: r.stepSize, tickSize: r.tickSize, quantityPrecision: r.quantityPrecision, liquidationFee: r.liquidationFee }
}
