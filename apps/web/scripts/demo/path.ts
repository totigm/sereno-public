import { BTC_SYMBOL, type Coin } from './coins'
import type { GridPoints } from './grid'
import { rngFor } from './random'
import { DAY_MS } from './time'

// Correlación de cada alt con BTC: el mercado se mueve junto, con ruido propio.
const BTC_CORRELATION = 0.6

// Caminata aleatoria geométrica hacia atrás desde el precio de la tabla: el último
// punto vale exactamente `coin.price` y lo anterior se deduce restando retornos.
// Todo se sortea desde el final, así una grilla que arranca antes (la que además
// cubre un replay) deja intactos los mismos puntos recientes. Devuelve logaritmos.
export function basePaths(seed: number, coins: readonly Coin[], points: GridPoints): Map<string, Float64Array> {
  const { times } = points
  const btcRng = rngFor(seed, 'mercado', BTC_SYMBOL)
  const market = new Float64Array(times.length)
  for (let i = times.length - 1; i >= 0; i--) market[i] = btcRng.normal()
  const out = new Map<string, Float64Array>()
  for (const coin of coins) {
    const rng = rngFor(seed, 'camino', coin.symbol)
    const logs = new Float64Array(times.length)
    const last = times.length - 1
    logs[last] = Math.log(coin.price)
    const own = coin.symbol === BTC_SYMBOL ? 0 : Math.sqrt(1 - BTC_CORRELATION ** 2)
    const shared = coin.symbol === BTC_SYMBOL ? 1 : BTC_CORRELATION
    for (let i = last; i > 0; i--) {
      const dt = (times[i] ?? 0) - (times[i - 1] ?? 0)
      const sigma = coin.dailyVol * Math.sqrt(dt / DAY_MS)
      const z = shared * (market[i] ?? 0) + own * rng.normal()
      logs[i - 1] = (logs[i] ?? 0) - sigma * z
    }
    out.set(coin.symbol, logs)
  }
  return out
}

export interface Anchor {
  index: number
  price: number
}

// Deforma la caminata base para que pase exactamente por los anclajes (entradas,
// salidas, picos de cada trade). Entre dos anclajes se conserva la textura de la
// base, sin su tendencia, escalada por `texture(desde)`: con 1 es la base tal cual
// corrida; con 0, una recta (en log) entre los anclajes. Antes del primer anclaje la
// base sólo se desplaza.
export function shapePath(base: Float64Array, anchors: readonly Anchor[], texture: (fromIndex: number) => number): Float64Array {
  const sorted = [...anchors].sort((a, b) => a.index - b.index)
  const out = new Float64Array(base.length)
  const first = sorted[0]
  if (!first) {
    for (let i = 0; i < base.length; i++) out[i] = Math.exp(base[i] ?? 0)
    return out
  }
  const shift = Math.log(first.price) - (base[first.index] ?? 0)
  for (let i = 0; i <= first.index; i++) out[i] = Math.exp((base[i] ?? 0) + shift)
  for (let k = 0; k + 1 < sorted.length; k++) {
    const a = sorted[k]
    const b = sorted[k + 1]
    if (!a || !b) continue
    if (a.index === b.index) throw new RangeError(`Dos anclajes en el mismo punto (${a.index})`)
    const f = texture(a.index)
    const la = Math.log(a.price)
    const lb = Math.log(b.price)
    const ba = base[a.index] ?? 0
    const bb = base[b.index] ?? 0
    for (let i = a.index; i <= b.index; i++) {
      const w = (i - a.index) / (b.index - a.index)
      const detrended = (base[i] ?? 0) - ((1 - w) * ba + w * bb)
      out[i] = Math.exp((1 - w) * la + w * lb + f * detrended)
    }
  }
  const last = sorted[sorted.length - 1]
  if (last && last.index < base.length - 1) {
    const tail = Math.log(last.price) - (base[last.index] ?? 0)
    for (let i = last.index; i < base.length; i++) out[i] = Math.exp((base[i] ?? 0) + tail)
  }
  return out
}
