// Refresco diario de `symbols` (spec §10 y §12): todos los contratos de exchangeInfo,
// operables o no (un deslistado conserva su última fila), con el intervalo de funding de
// `fundingInfo` y el mmr de la tabla de settings. El spread observado no se toca.

import type { ContractMeta } from '@sereno/core'
import type { SymbolUpsert, SymbolsRepo } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import { fundingIntervalFor, fundingIntervalsOf, mmrFor, type MmrTable } from '../binance/symbol-info'
import type { Logger } from '../logger'

export interface RefreshSymbolsDeps {
  rest: Pick<BinanceRest, 'exchangeInfo' | 'fundingInfo'>
  repos: { symbols: Pick<SymbolsRepo, 'upsertMany'> }
  logger: Logger
}

export interface RefreshedSymbols {
  // Lo que consumen el universo (`selectUniverse`) y el mapeo a `SymbolInfo`.
  contracts: ContractMeta[]
  fundingIntervals: Map<string, number>
}

export async function refreshSymbols({ rest, repos, logger }: RefreshSymbolsDeps, risk: MmrTable): Promise<RefreshedSymbols> {
  const [contracts, funding] = await Promise.all([rest.exchangeInfo(), rest.fundingInfo()])
  const fundingIntervals = fundingIntervalsOf(funding)
  await repos.symbols.upsertMany(contracts.map((c) => toSymbolUpsert(c, fundingIntervals, risk)))
  logger.info({ contracts: contracts.length, withFundingInfo: fundingIntervals.size }, 'Contratos actualizados')
  return { contracts, fundingIntervals }
}

export function toSymbolUpsert(contract: ContractMeta, fundingIntervals: ReadonlyMap<string, number>, risk: MmrTable): SymbolUpsert {
  const { filters } = contract
  return {
    symbol: contract.symbol,
    baseAsset: contract.baseAsset,
    quoteAsset: contract.quoteAsset,
    contractType: contract.contractType,
    status: contract.status,
    minNotional: filters.minNotional,
    minQty: filters.minQty,
    stepSize: filters.stepSize,
    tickSize: filters.tickSize,
    quantityPrecision: filters.quantityPrecision,
    underlyingType: contract.underlyingType,
    underlyingSubType: [...contract.underlyingSubType],
    onboardDate: contract.onboardDate,
    fundingIntervalHours: fundingIntervalFor(contract.symbol, fundingIntervals),
    liquidationFee: filters.liquidationFee,
    mmr: mmrFor(contract.symbol, risk),
  }
}
