import type { ContractMeta } from '../types'

// Filtros de candidatura de un contrato (spec §5.1). Son independientes del ranking:
// sólo dicen si el contrato es elegible y, si no, por qué.

export const STABLECOINS = ['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE', 'BUSD', 'USD1', 'USDD'] as const

export const DAY_MS = 86_400_000

export type ContractFilterReason =
  | 'contract_type'
  | 'status'
  | 'quote_asset'
  | 'underlying_type'
  | 'tradfi'
  | 'stablecoin'
  | 'history'

export interface ContractFilterOptions {
  /** Marca de tiempo (ms UTC) del día que se está seleccionando. */
  today: number
  includeTradFi: boolean
  minHistoryDays: number
}

const STABLECOIN_SET: ReadonlySet<string> = new Set(STABLECOINS)

// Devuelve el primer filtro que el contrato no pasa, o `null` si es candidato.
// El orden importa: va del más estructural (tipo de contrato) al más fino (historia),
// para que la razón que ve Toti en el dashboard sea la más informativa.
export function rejectContract(contract: ContractMeta, options: ContractFilterOptions): ContractFilterReason | null {
  if (contract.contractType !== 'PERPETUAL') return 'contract_type'
  if (contract.status !== 'TRADING') return 'status'
  if (contract.quoteAsset !== 'USDT') return 'quote_asset'
  // Los contratos TradFi (oro, acciones tokenizadas) llegan con underlyingType distinto de
  // COIN (p. ej. COMMODITY): se los decide por el toggle, no por underlyingType, para que
  // la razón de exclusión sea "tradfi" y no un detalle del exchange.
  if (contract.underlyingSubType.includes('TradFi')) {
    if (!options.includeTradFi) return 'tradfi'
  } else if (contract.underlyingType !== 'COIN') {
    return 'underlying_type'
  }
  if (STABLECOIN_SET.has(contract.baseAsset.toUpperCase())) return 'stablecoin'
  if (contract.onboardDate > options.today - options.minHistoryDays * DAY_MS) return 'history'
  return null
}
