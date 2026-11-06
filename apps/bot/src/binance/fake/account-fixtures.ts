// La cuenta del Binance falso para los pedidos firmados: una clave y un secret falsos (los
// tests nunca usan una clave real), los brackets de apalancamiento y las comisiones.

import type { RawBracketTier, RawCommissionRate, RawLeverageBracket } from '../types'

export const FAKE_API_KEY = 'clave-falsa-de-prueba'
export const FAKE_API_SECRET = 'secreto-falso-de-prueba'

export const KEY_REJECTED_ERROR = { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }

function tiers(...rows: [floor: number, cap: number, mmr: number, leverage: number][]): RawBracketTier[] {
  let cum = 0
  return rows.map(([notionalFloor, notionalCap, maintMarginRatio, initialLeverage], i) => {
    const previous = rows[i - 1]
    if (previous) cum += notionalFloor * (maintMarginRatio - previous[2])
    return { bracket: i + 1, initialLeverage, notionalCap, notionalFloor, maintMarginRatio, cum }
  })
}

// Valores con la forma de Binance. El de BTC viene con el tier 2 primero (Binance no
// garantiza el orden); BTCUSDT_261226 es trimestral y ZZZUSDT no está en el catálogo.
export const LEVERAGE_BRACKETS: RawLeverageBracket[] = [
  { symbol: 'BTCUSDT', brackets: tiers([0, 50_000, 0.004, 125], [50_000, 600_000, 0.005, 100]).reverse() },
  { symbol: 'ETHUSDT', brackets: tiers([0, 50_000, 0.005, 125], [50_000, 600_000, 0.0065, 100]) },
  { symbol: 'SOLUSDT', brackets: tiers([0, 10_000, 0.01, 75], [10_000, 100_000, 0.015, 50]) },
  { symbol: '1000PEPEUSDT', brackets: tiers([0, 5_000, 0.015, 50], [5_000, 25_000, 0.02, 25]) },
  { symbol: 'XAUUSDT', brackets: tiers([0, 20_000, 0.01, 50]) },
  { symbol: 'USDCUSDT', brackets: tiers([0, 100_000, 0.005, 50]) },
  { symbol: 'NEWUSDT', brackets: tiers([0, 5_000, 0.025, 20]) },
  { symbol: 'BTCUSDT_261226', brackets: tiers([0, 375_000, 0.005, 25]) },
  { symbol: 'ZZZUSDT', notionalCoef: 1.5, brackets: tiers([0, 5_000, 0.03, 20]) },
]

// Las del VIP 0 con el descuento por pagar en BNB.
export const COMMISSION_RATE: Omit<RawCommissionRate, 'symbol'> = { makerCommissionRate: '0.000180', takerCommissionRate: '0.000450' }
