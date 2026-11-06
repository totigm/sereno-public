// El riesgo de la sesión con el mmr y las comisiones de la cuenta de Binance encima. Una
// moneda que Binance ya no devuelve conserva su mmr: puede ser un contrato deslistado con
// una abierta, cuya liquidación no tiene que moverse.

import type { Settings } from '@sereno/shared'

type Risk = Settings['risk']

export interface AccountTiers {
  // mmr del tier 1 por símbolo, tal como lo devolvió Binance.
  mmr: ReadonlyMap<string, number>
  takerFeeRate: number
  makerFeeRate: number
}

// Sólo las monedas de `catalog`: lo que Binance lista y el bot no conoce no entra a los ajustes.
export function withAccountTiers(risk: Risk, tiers: AccountTiers, catalog: ReadonlySet<string>): Risk {
  const merged: Record<string, number> = { ...risk.mmrBySymbol }
  for (const [symbol, mmr] of tiers.mmr) {
    if (catalog.has(symbol)) merged[symbol] = mmr
  }
  const mmrBySymbol = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return { ...risk, mmrBySymbol, takerFeeRate: tiers.takerFeeRate, makerFeeRate: tiers.makerFeeRate }
}
