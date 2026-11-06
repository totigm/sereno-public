import type { Side } from '../types'

// Precio de liquidación en margen aislado, tier 1 (`cum = 0`), según Binance USDT-M
// (spec §6). Es la fórmula que usan tanto el plan de entrada como el simulador.
export function liquidationPrice(side: Side, entry: number, leverage: number, mmr: number): number {
  return side === 'long' ? (entry * (1 - 1 / leverage)) / (1 - mmr) : (entry * (1 + 1 / leverage)) / (1 + mmr)
}

export const LIQUIDATION_STOP_MULTIPLE = 3

export interface LiquidationCheck {
  side: Side
  entry: number
  stopPrice: number
  liquidationPrice: number
}

// Invariante de spec §5.5: `|liquidación − entrada| ≥ multiple × |stop − entrada|`.
// Exige además que la liquidación esté del lado adverso de la entrada: una
// liquidación "del lado bueno" sólo puede venir de un parámetro roto.
export function liquidationFarEnough(check: LiquidationCheck, multiple = LIQUIDATION_STOP_MULTIPLE): boolean {
  const { side, entry, stopPrice, liquidationPrice: liq } = check
  const adverse = side === 'long' ? entry - liq : liq - entry
  if (adverse <= 0) return false
  return adverse >= multiple * Math.abs(stopPrice - entry)
}
