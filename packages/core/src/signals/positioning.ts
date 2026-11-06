// Posicionamiento (spec §5.3a): ratio long/short de cuentas y ratio taker buy/sell, contrarian suave.
//   por ratio: −0,5 si > 2, +0,5 si < 0,5, 0 entre 0,5 y 2 (inclusive)
//   valor = promedio de los ratios con dato (positivos y finitos)
// Signo: + = long (demasiados shorts o vendedores agresivos: se apuesta al lado contrario).
import type { MarketView, SignalResult } from '../types'
import { noData, signalResult } from './result'

const HIGH = 2
const LOW = 0.5
const EXTREME_VALUE = 0.5

export function positioningValue(ratio: number): number {
  if (ratio > HIGH) return -EXTREME_VALUE
  if (ratio < LOW) return EXTREME_VALUE
  return 0
}

const usable = (ratio: number | null | undefined): ratio is number =>
  ratio !== null && ratio !== undefined && Number.isFinite(ratio) && ratio > 0

export function positioning(view: MarketView): SignalResult {
  const detail: Record<string, number> = {}
  const longShort = view.futures?.longShortRatio
  const taker = view.futures?.takerRatio
  if (usable(longShort)) detail.longShortRatio = longShort
  if (usable(taker)) detail.takerRatio = taker
  const ratios = Object.values(detail)
  if (ratios.length === 0) return noData('positioning')
  const value = ratios.reduce((acc, r) => acc + positioningValue(r), 0) / ratios.length
  return signalResult('positioning', value, detail)
}
