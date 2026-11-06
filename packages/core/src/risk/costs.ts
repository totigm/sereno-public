import type { Settings } from '@sereno/shared'
import type { SymbolInfo } from '../types'

export type RiskSettings = Settings['risk']

// Costo de ida y vuelta de una posición, como fracción del nocional (spec §5.5):
// dos comisiones taker, el spread completo (dos medios spreads) y dos slippages.
// Es el piso del stop: un stop más chico que unas pocas veces este costo pierde
// contra la fricción aunque la señal acierte.
export function roundTripCost(info: SymbolInfo, risk: RiskSettings): number {
  return 2 * risk.takerFeeRate + 2 * info.halfSpreadRate + 2 * risk.slippageRate
}
