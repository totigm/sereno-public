// Piezas comunes de las señales: construir un `SignalResult` que nunca lleve NaN.
// Un valor no finito (indicador en calentamiento, dato roto) es "sin dato": `value: null`.
import type { Candle, SignalId, SignalResult } from '../types'

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function noData(id: SignalId): SignalResult {
  return { id, value: null }
}

// El detalle sólo conserva números finitos y se omite si no queda ninguno.
export function signalResult(id: SignalId, value: number, detail: Record<string, number> = {}): SignalResult {
  if (!Number.isFinite(value)) return noData(id)
  const finite = Object.entries(detail).filter(([, v]) => Number.isFinite(v))
  return finite.length === 0 ? { id, value } : { id, value, detail: Object.fromEntries(finite) }
}

export function closesOf(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close)
}
