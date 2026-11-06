// `SymbolInfo` del simulador a partir de la tabla `symbols` (que conserva la última fila
// de un contrato deslistado: una abierta en él se sigue pudiendo retomar y cerrar). El
// mmr sale de los ajustes de la sesión y el medio spread de lo observado o del supuesto
// del replay: el simulador fija sus contratos al crearse (ver Decisiones del runtime).

import type { SymbolInfo } from '@sereno/core'
import type { SymbolRecord } from '@sereno/db'
import { halfSpreadRate, mmrFor, type MmrTable } from '../binance/symbol-info'

export function infoFromRecord(r: SymbolRecord, risk: MmrTable): SymbolInfo {
  return {
    symbol: r.symbol,
    baseAsset: r.baseAsset,
    minNotional: r.minNotional,
    minQty: r.minQty,
    stepSize: r.stepSize,
    tickSize: r.tickSize,
    quantityPrecision: r.quantityPrecision,
    mmr: mmrFor(r.symbol, risk),
    liquidationFee: r.liquidationFee,
    fundingIntervalHours: r.fundingIntervalHours,
    halfSpreadRate: halfSpreadRate(r.symbol, null, r.observedSpread),
    underlyingType: r.underlyingType,
    underlyingSubType: [...r.underlyingSubType],
    onboardDate: r.onboardDate,
  }
}

export function infosFrom(records: readonly SymbolRecord[], risk: MmrTable): Record<string, SymbolInfo> {
  return Object.fromEntries(records.map((r) => [r.symbol, infoFromRecord(r, risk)]))
}
