// La fila de `universe_days` de un día (spec §5.1) a partir de la selección: ranking por
// volumen de 24 h, mínimos de cada contrato, por qué sigue cada abierta que hoy no entraría
// y por qué quedó afuera cada moneda que no pasó un filtro. La misma en vivo y en replay.

import type { ContractMeta } from '@sereno/core'
import { utcDay } from '@sereno/core/src/replay/clock'
import type { SelectUniverseResult, UniverseExclusionReason } from '@sereno/core/src/universe/select-universe'
import type { UniverseDayEntry, UniverseExcluded, UniverseExcludedEntry } from '@sereno/db'

export type ContractFilters = ContractMeta['filters']

export interface SnapshotInput {
  contracts: readonly ContractMeta[]
  // `quoteVolume` de 24 h por moneda; sin dato, volumen cero.
  volumes: Readonly<Record<string, number>>
  pinned: readonly string[]
  // Mínimos de las abiertas deslistadas (no están en `contracts`): su último snapshot conocido.
  delistedFilters?: ReadonlyMap<string, ContractFilters>
}

export interface UniverseSnapshot {
  entries: UniverseDayEntry[]
  excluded: UniverseExcluded
}

export function universeSnapshot(result: SelectUniverseResult, { contracts, volumes, pinned, delistedFilters }: SnapshotInput): UniverseSnapshot {
  const filters = new Map<string, ContractFilters>([...contracts.map((c): [string, ContractFilters] => [c.symbol, c.filters]), ...(delistedFilters ?? [])])
  const pinnedSet = new Set(pinned)
  const delisted = new Set(result.delisted)
  const entries = byVolume(result.symbols, volumes).map((symbol, i): UniverseDayEntry => {
    const keptOpen = result.keptOpen[symbol]
    return {
      symbol,
      rank: i + 1,
      quoteVolume24h: volumes[symbol] ?? 0,
      // Entró por estar fijada (no por ser una abierta que hoy no pasa un filtro).
      pinned: pinnedSet.has(symbol) && keptOpen === undefined && !delisted.has(symbol),
      filters: filters.get(symbol) ?? ZERO_FILTERS,
      ...(keptOpen === undefined ? {} : { keptOpen }),
      ...(delisted.has(symbol) ? { delisted: true as const } : {}),
    }
  })
  return { entries, excluded: excludedEntries(result, contracts) }
}

// `pinnedExcluded` es un subconjunto de `excludedByFilter`: cada fijada que no entró ya
// está en el mapa y sólo suma la marca.
function excludedEntries(result: SelectUniverseResult, contracts: readonly ContractMeta[]): UniverseExcluded {
  const bySymbol = new Map(contracts.map((c) => [c.symbol, c]))
  const excluded: UniverseExcluded = {}
  for (const [symbol, reason] of Object.entries(result.excludedByFilter)) {
    const contract = bySymbol.get(symbol)
    const detail = contract === undefined ? undefined : exclusionDetail(reason, contract)
    const entry: UniverseExcludedEntry = { reason }
    if (detail !== undefined) entry.detail = detail
    if (result.pinnedExcluded[symbol] !== undefined) entry.pinned = true
    excluded[symbol] = entry
  }
  return excluded
}

// El dato del contrato que no pasó el filtro, para que el dashboard diga algo más que el
// motivo. Los motivos que no dependen de un dato del contrato (excluida a mano, sin
// volumen, sin contrato, TradFi) no llevan detalle.
function exclusionDetail(reason: UniverseExclusionReason, contract: ContractMeta): string | undefined {
  switch (reason) {
    case 'contract_type':
      return contract.contractType
    case 'status':
      return contract.status
    case 'quote_asset':
      return contract.quoteAsset
    case 'underlying_type':
      return contract.underlyingType
    case 'stablecoin':
      return contract.baseAsset
    case 'history':
      return utcDay(contract.onboardDate)
    case 'tradfi':
    case 'excluded':
    case 'no_volume':
    case 'no_contract':
      return undefined
  }
}

// El ranking del snapshot es por volumen de 24 h (mayor primero, empates por nombre), no
// la posición en el universo, que pone primero las fijadas. Sin ticker, volumen cero.
function byVolume(symbols: readonly string[], volumes: Readonly<Record<string, number>>): string[] {
  const volume = (s: string): number => volumes[s] ?? 0
  return [...symbols].sort((a, b) => volume(b) - volume(a) || (a < b ? -1 : a > b ? 1 : 0))
}

// Una deslistada que nunca pasó por `symbols` (no debería pasar: el refresco guarda todos
// los contratos) igual se sigue hasta cerrarla; sus mínimos quedan en cero, no inventados.
const ZERO_FILTERS: ContractFilters = { minNotional: 0, minQty: 0, stepSize: 0, tickSize: 0, quantityPrecision: 0, liquidationFee: 0 }
