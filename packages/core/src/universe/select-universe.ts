import type { Settings } from '@sereno/shared'
import type { ContractMeta } from '../types'
import { rejectContract, type ContractFilterReason } from './contract-filter'

export { STABLECOINS, DAY_MS, rejectContract } from './contract-filter'
export type { ContractFilterReason, ContractFilterOptions } from './contract-filter'

// Selección diaria del universo (spec §5.1). Función pura: la misma en vivo y en replay.

// `no_contract`: un fijado que no está en `contracts` (mal escrito o deslistado).
export type UniverseExclusionReason = ContractFilterReason | 'excluded' | 'no_volume' | 'no_contract'

export interface SelectUniverseInput {
  contracts: ContractMeta[]
  /** `quoteVolume` de las últimas 24 h por símbolo. Un símbolo sin volumen no se rankea. */
  volumes: Record<string, number>
  /** Marca de tiempo (ms UTC) del día que se está seleccionando. */
  today: number
  settings: Settings['universe']
  /** Símbolos con posición abierta: se mantienen aunque salgan del top. */
  openSymbols: string[]
}

export interface SelectUniverseResult {
  /** Fijados primero, después el top por volumen, al final los abiertos que cayeron del top. */
  symbols: string[]
  /** Por qué quedó afuera cada símbolo que no entró por filtro (nunca contiene uno de `symbols`). */
  excludedByFilter: Record<string, UniverseExclusionReason>
  /** Abiertos que hoy no pasan un filtro: siguen en `symbols` sólo por la posición, con su motivo. */
  keptOpen: Record<string, UniverseExclusionReason>
  /** Fijados que quedan afuera porque no pasan un filtro o no tienen contrato (subconjunto de `excludedByFilter`). */
  pinnedExcluded: Record<string, UniverseExclusionReason>
  /** Abiertos cuyo contrato ya no está en `contracts`: siguen en `symbols` hasta que el motor los cierre. */
  delisted: string[]
}

interface Candidate { symbol: string; volume: number }

export function selectUniverse(input: SelectUniverseInput): SelectUniverseResult {
  const { contracts, volumes, today, settings, openSymbols } = input
  const excludedByFilter: Record<string, UniverseExclusionReason> = {}
  const candidates: Candidate[] = []

  for (const contract of contracts) {
    const outcome = classify(contract, input)
    if (typeof outcome === 'string') excludedByFilter[contract.symbol] = outcome
    else candidates.push(outcome)
  }

  const pinnedRequested = [...new Set(settings.pinned)]
  const candidateSymbols = new Set(candidates.map((c) => c.symbol))
  const pinned = pinnedRequested.filter((symbol) => candidateSymbols.has(symbol))
  const pinnedSet = new Set(pinned)
  const ranked = candidates
    .filter((c) => !pinnedSet.has(c.symbol))
    .sort((a, b) => b.volume - a.volume || compareSymbols(a.symbol, b.symbol))
    .map((c) => c.symbol)

  // Los fijados ocupan lugar dentro de topN; si son más que topN, entran todos igual.
  const symbols = [...pinned, ...ranked.slice(0, Math.max(0, settings.topN - pinned.length))]
  const chosen = new Set(symbols)

  // Una moneda con posición abierta se mantiene hasta cerrarla, aunque haya caído del top,
  // deje de pasar un filtro o su contrato desaparezca de exchangeInfo: el motor sigue
  // necesitando sus datos para manejar el stop o cerrarla como `delisted`.
  const known = new Set(contracts.map((c) => c.symbol))
  const keptOpen: Record<string, UniverseExclusionReason> = {}
  const delisted: string[] = []
  for (const symbol of openSymbols) {
    if (chosen.has(symbol)) continue
    chosen.add(symbol)
    symbols.push(symbol)
    if (!known.has(symbol)) delisted.push(symbol)
    const reason = excludedByFilter[symbol]
    if (reason !== undefined) {
      keptOpen[symbol] = reason
      delete excludedByFilter[symbol]
    }
  }

  // Un fijado sin historia, sin volumen o sin contrato no se puede operar: queda afuera, pero
  // explicado. Si tiene posición abierta ya está en `symbols` (en `keptOpen` o `delisted`).
  const pinnedExcluded: Record<string, UniverseExclusionReason> = {}
  for (const symbol of pinnedRequested) {
    if (chosen.has(symbol)) continue
    if (!known.has(symbol)) excludedByFilter[symbol] = 'no_contract'
    const reason = excludedByFilter[symbol]
    if (reason !== undefined) pinnedExcluded[symbol] = reason
  }

  return { symbols, excludedByFilter, keptOpen, pinnedExcluded, delisted }
}

// Desempate por símbolo con comparación de code units (no `localeCompare`): el orden tiene
// que ser idéntico en vivo y en replay, sin depender del locale del proceso.
function compareSymbols(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function classify(contract: ContractMeta, input: SelectUniverseInput): Candidate | UniverseExclusionReason {
  const { settings, volumes, today } = input
  // La exclusión manual gana sobre todo lo demás, incluso sobre `pinned`.
  if (settings.excluded.includes(contract.symbol)) return 'excluded'
  const reason = rejectContract(contract, { today, includeTradFi: settings.includeTradFi, minHistoryDays: settings.minHistoryDays })
  if (reason) return reason
  const volume = volumes[contract.symbol]
  if (volume === undefined || !Number.isFinite(volume)) return 'no_volume'
  return { symbol: contract.symbol, volume }
}
