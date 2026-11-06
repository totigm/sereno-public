// De `ContractMeta` (exchangeInfo) a `SymbolInfo`, lo que consumen el motor y el
// simulador: filtros aplanados más lo que no viene en exchangeInfo (mmr de settings,
// intervalo de funding de `fundingInfo`, medio spread del libro).

import type { ContractMeta, SymbolInfo } from '@sereno/core'
import type { Settings } from '@sereno/shared'
import type { BookTicker, FundingInfo } from './types'

// `fundingInfo` sólo lista los contratos con intervalo o topes ajustados; el resto paga cada 8 h (spec §3).
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8

// Medio spread cuando no hay libro utilizable ni observación del símbolo: los supuestos
// del replay (spec §6), 0,01 % en BTC y ETH y 0,025 % en el resto. Son mayores que el
// spread real típico de las monedas grandes: sin dato, el costo se estima en contra del bot.
export const FALLBACK_HALF_SPREAD_MAJOR = 0.0001
export const FALLBACK_HALF_SPREAD_OTHER = 0.00025
const MAJORS: ReadonlySet<string> = new Set(['BTCUSDT', 'ETHUSDT'])

export type MmrTable = Pick<Settings['risk'], 'mmrBySymbol' | 'mmrDefault'>

export interface SymbolInfoSources {
  risk: MmrTable
  fundingIntervals: ReadonlyMap<string, number>
  // Libro del símbolo en el momento; sin él, `observedHalfSpread` y después el supuesto.
  book?: BookTicker | null
  // `symbols.observedSpread`: la mediana medida en vivo, null hasta tener 24 h de datos.
  observedHalfSpread?: number | null
}

export function mmrFor(symbol: string, risk: MmrTable): number {
  return risk.mmrBySymbol[symbol] ?? risk.mmrDefault
}

export function fundingIntervalsOf(info: readonly FundingInfo[]): Map<string, number> {
  return new Map(info.map((f) => [f.symbol, f.fundingIntervalHours]))
}

export function fundingIntervalFor(symbol: string, intervals: ReadonlyMap<string, number>): number {
  return intervals.get(symbol) ?? DEFAULT_FUNDING_INTERVAL_HOURS
}

// (ask − bid) / (2 × mid); null si el libro está vacío, sin precio o cruzado.
export function bookHalfSpread(book: BookTicker): number | null {
  const usable = Number.isFinite(book.bidPrice) && Number.isFinite(book.askPrice) && book.bidPrice > 0 && book.askPrice > book.bidPrice
  return usable ? (book.askPrice - book.bidPrice) / (book.askPrice + book.bidPrice) : null
}

// El del libro; sin libro utilizable, lo observado del símbolo (si es un número positivo)
// y, si no, el supuesto.
export function halfSpreadRate(symbol: string, book: BookTicker | null | undefined, observed: number | null = null): number {
  if (book && book.symbol !== symbol) throw new RangeError(`halfSpreadRate: libro de ${book.symbol} para ${symbol}`)
  const fromBook = book ? bookHalfSpread(book) : null
  if (fromBook !== null) return fromBook
  if (observed !== null && Number.isFinite(observed) && observed > 0) return observed
  return MAJORS.has(symbol) ? FALLBACK_HALF_SPREAD_MAJOR : FALLBACK_HALF_SPREAD_OTHER
}

export function toSymbolInfo(contract: ContractMeta, { risk, fundingIntervals, book, observedHalfSpread = null }: SymbolInfoSources): SymbolInfo {
  const { filters } = contract
  return {
    symbol: contract.symbol,
    baseAsset: contract.baseAsset,
    minNotional: filters.minNotional,
    minQty: filters.minQty,
    stepSize: filters.stepSize,
    tickSize: filters.tickSize,
    quantityPrecision: filters.quantityPrecision,
    mmr: mmrFor(contract.symbol, risk),
    liquidationFee: filters.liquidationFee,
    fundingIntervalHours: fundingIntervalFor(contract.symbol, fundingIntervals),
    halfSpreadRate: halfSpreadRate(contract.symbol, book, observedHalfSpread),
    underlyingType: contract.underlyingType,
    underlyingSubType: [...contract.underlyingSubType],
    onboardDate: contract.onboardDate,
  }
}
