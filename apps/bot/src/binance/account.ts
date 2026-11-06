// Lo que la clave de sólo lectura trae de la cuenta: el mmr de cada moneda y las
// comisiones. El mmr es el del tier 1 (`notionalFloor` 0), coherente con la fórmula de
// liquidación del spec §6 (margen aislado, tier 1, `cum = 0`).

import type { CommissionRate, RawCommissionRate, RawLeverageBracket } from './types'

// Un bracket raro (sin tier 1, mmr fuera de (0, 1)) no entra: esa moneda sigue con el supuesto.
export function toTierOneMmr(raw: readonly RawLeverageBracket[]): Map<string, number> {
  const mmr = new Map<string, number>()
  for (const { symbol, brackets } of raw) {
    const tier = brackets.find((b) => b.notionalFloor === 0)
    if (tier && Number.isFinite(tier.maintMarginRatio) && tier.maintMarginRatio > 0 && tier.maintMarginRatio < 1) mmr.set(symbol, tier.maintMarginRatio)
  }
  return mmr
}

export function toCommissionRate(raw: RawCommissionRate): CommissionRate {
  return { symbol: raw.symbol, takerFeeRate: feeRate(raw.takerCommissionRate), makerFeeRate: feeRate(raw.makerCommissionRate) }
}

function feeRate(value: string): number {
  // `Number('')` vale 0: un campo vacío no puede pasar por comisión gratis.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`Binance: comisión inválida "${value}"`)
  return n
}
