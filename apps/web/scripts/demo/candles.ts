import type { Candle } from '@sereno/core'
import type { Coin } from './coins'
import type { GridPoints } from './grid'
import { rngFor } from './random'
import { DAY_MS } from './time'

// Mechas y volumen de cada vela, sorteados una sola vez por moneda: al reintentar un
// tramo con menos textura se achican, pero no cambian de forma. Se sortean desde la
// última vela, como el camino: más historia no cambia las velas recientes.
export interface CandleNoise {
  up: Float64Array
  down: Float64Array
  volume: Float64Array
}

export function candleNoise(seed: number, coin: Coin, points: GridPoints): CandleNoise {
  const rng = rngFor(seed, 'velas', coin.symbol)
  const n = points.times.length - 1
  const sigma = coin.dailyVol * Math.sqrt((points.times[1]! - points.times[0]!) / DAY_MS)
  const up = new Float64Array(n)
  const down = new Float64Array(n)
  const volume = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    up[i] = Math.abs(rng.normal()) * sigma * 0.6
    down[i] = Math.abs(rng.normal()) * sigma * 0.6
    volume[i] = Math.exp(0.35 * rng.normal())
  }
  return { up, down, volume }
}

export interface CandleInput {
  coin: Coin
  prices: Float64Array
  points: GridPoints
  noise: CandleNoise
  // Escala de las mechas por vela (la misma textura que el camino).
  wickScale: (candle: number) => number
}

// Velas de la grilla: la vela `i` va del punto `i` al `i + 1`. La última, si termina
// en `end` y no en un cierre, es la vela abierta (`closed: false`).
export function buildCandles({ coin, prices, points, noise, wickScale }: CandleInput): Candle[] {
  const { times, lastBoundary } = points
  const step = times[1]! - times[0]!
  const perCandleQuote = (coin.quoteVolume24h * step) / DAY_MS
  const out: Candle[] = []
  for (let i = 0; i + 1 < times.length; i++) {
    const open = prices[i]!
    const close = prices[i + 1]!
    const scale = wickScale(i)
    const high = Math.max(open, close) * Math.exp(noise.up[i]! * scale)
    const low = Math.min(open, close) * Math.exp(-noise.down[i]! * scale)
    const quoteVolume = perCandleQuote * noise.volume[i]! * ((times[i + 1]! - times[i]!) / step)
    out.push({
      openTime: times[i]!,
      closeTime: times[i]! + step - 1,
      open,
      high,
      low,
      close,
      volume: quoteVolume / ((open + close) / 2),
      quoteVolume,
      closed: i < lastBoundary,
    })
  }
  return out
}

// Agrega velas consecutivas a un marco mayor alineado (1h, 4h). Un grupo incompleto
// al final queda abierto, como lo devuelve Binance mientras la vela no cerró.
export function aggregate(candles: readonly Candle[], step: number): Candle[] {
  const groups = new Map<number, Candle[]>()
  for (const c of candles) {
    const key = Math.floor(c.openTime / step) * step
    const group = groups.get(key)
    if (group) group.push(c)
    else groups.set(key, [c])
  }
  const out: Candle[] = []
  for (const [openTime, group] of groups) {
    const first = group[0]!
    const last = group[group.length - 1]!
    const complete = last.closed && last.closeTime === openTime + step - 1
    out.push({
      openTime,
      closeTime: openTime + step - 1,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: last.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
      quoteVolume: group.reduce((sum, c) => sum + c.quoteVolume, 0),
      closed: complete,
    })
  }
  return out
}
