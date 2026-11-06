import type { Coin } from './coins'
import { rngFor } from './random'
import { HOUR_MS } from './time'

// Los cobros de funding de una moneda caen en múltiplos de su intervalo (UTC).
export function fundingTimes(coin: Coin, from: number, to: number): number[] {
  const interval = coin.fundingIntervalHours * HOUR_MS
  const out: number[] = []
  for (let t = Math.floor(from / interval) * interval + interval; t <= to; t += interval) out.push(t)
  return out
}

// Tasa del evento: la típica de la moneda con ruido, igual para cualquier cartera.
export function fundingRate(seed: number, coin: Coin, at: number): number {
  return coin.funding * (1 + 0.6 * rngFor(seed, 'funding', coin.symbol, at).normal())
}
