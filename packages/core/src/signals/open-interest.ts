// Open interest (spec §5.3a): cambio de OI junto al del precio en 1 h y 4 h; promedio de los horizontes con dato.
//   OI sube: sgn(Δprecio) × (0,5 + 0,5 × min(|Δprecio|, |ΔOI|, 1 %) / 1 %)   (posiciones nuevas: ±0,5…±1)
//   OI baja: sgn(Δprecio) × 0,2   (cierre de posiciones, poca convicción);   Δprecio = 0 o ΔOI = 0 ⇒ 0
// Signo: + = long (el precio sube). Δ = valor actual / valor de hace h − 1.
// El precio de hace h es el cierre de la última vela de 15m que cerró al menos h antes que la vigente.
import { lastIndexAtOrBefore } from '../market/search'
import type { Candle, FuturesSnapshot, MarketView, SignalResult } from '../types'
import { noData, signalResult } from './result'

const HOUR_MS = 3_600_000
const FULL_MOVE = 0.01
const CLOSING_VALUE = 0.2

export function openInterestValue(priceChange: number, oiChange: number): number {
  if (priceChange === 0 || oiChange === 0) return 0
  if (oiChange < 0) return Math.sign(priceChange) * CLOSING_VALUE
  const strength = Math.min(Math.abs(priceChange), Math.abs(oiChange), FULL_MOVE) / FULL_MOVE
  return Math.sign(priceChange) * (0.5 + 0.5 * strength)
}

const byCloseTime = (c: Candle): number => c.closeTime

function change(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || !(before > 0) || !(now > 0)) return null
  const value = now / before - 1
  return Number.isFinite(value) ? value : null
}

function horizonValue(candles: readonly Candle[], oiNow: number, oiBefore: number | null, hours: number): number | null {
  const current = candles.at(-1)
  if (current === undefined) return null
  const before = candles[lastIndexAtOrBefore(candles, byCloseTime, current.closeTime - hours * HOUR_MS)]
  const priceChange = change(current.close, before?.close)
  const oiChange = change(oiNow, oiBefore)
  return priceChange === null || oiChange === null ? null : openInterestValue(priceChange, oiChange)
}

function horizons(candles: readonly Candle[], futures: FuturesSnapshot, oiNow: number): Record<string, number> {
  const out: Record<string, number> = {}
  const h1 = horizonValue(candles, oiNow, futures.openInterest1hAgo, 1)
  const h4 = horizonValue(candles, oiNow, futures.openInterest4hAgo, 4)
  if (h1 !== null) out.value1h = h1
  if (h4 !== null) out.value4h = h4
  return out
}

export function openInterest(view: MarketView): SignalResult {
  const futures = view.futures
  const oiNow = futures?.openInterest ?? null
  if (futures === null || oiNow === null) return noData('openInterest')
  const detail = horizons(view.candles['15m'], futures, oiNow)
  const values = Object.values(detail)
  if (values.length === 0) return noData('openInterest')
  return signalResult('openInterest', values.reduce((a, b) => a + b, 0) / values.length, detail)
}
