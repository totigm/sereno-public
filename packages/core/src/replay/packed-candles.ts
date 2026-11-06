import type { Candle } from '../types'

// Velas de una serie guardadas en columnas (un arreglo tipado por campo) en lugar de un
// objeto por vela: ≈ 65 B por vela contra ≈ 350 B. Un replay de 180 días sobre todo el
// universo son millones de velas y como objetos no entran en el heap de Node. El orden y
// la unicidad son los de `CandleSeries`: por `openTime` creciente y, si dos velas abren en
// el mismo instante, queda la que llegó última.

export class PackedCandles {
  private constructor(
    readonly openTime: Float64Array,
    readonly closeTime: Float64Array,
    readonly open: Float64Array,
    readonly high: Float64Array,
    readonly low: Float64Array,
    readonly close: Float64Array,
    readonly volume: Float64Array,
    readonly quoteVolume: Float64Array,
    readonly closed: Uint8Array,
  ) {}

  static readonly EMPTY = PackedCandles.allocate(0)

  static from(candles: readonly Candle[]): PackedCandles {
    // Orden estable por apertura y, entre iguales, la última que llegó.
    const sorted = candles.map((c, i) => ({ c, i })).sort((a, b) => a.c.openTime - b.c.openTime || a.i - b.i)
    const unique: Candle[] = []
    for (const { c } of sorted) {
      if (unique.length > 0 && (unique[unique.length - 1] as Candle).openTime === c.openTime) unique[unique.length - 1] = c
      else unique.push(c)
    }
    const out = PackedCandles.allocate(unique.length)
    for (const [i, c] of unique.entries()) {
      out.openTime[i] = c.openTime
      out.closeTime[i] = c.closeTime
      out.open[i] = c.open
      out.high[i] = c.high
      out.low[i] = c.low
      out.close[i] = c.close
      out.volume[i] = c.volume
      out.quoteVolume[i] = c.quoteVolume
      out.closed[i] = c.closed ? 1 : 0
    }
    return out
  }

  private static allocate(n: number): PackedCandles {
    const f = () => new Float64Array(n)
    return new PackedCandles(f(), f(), f(), f(), f(), f(), f(), f(), new Uint8Array(n))
  }

  get length(): number {
    return this.openTime.length
  }

  // Una vela nueva, con los campos en el orden de `Candle`.
  at(i: number): Candle {
    return {
      openTime: this.openTime[i] as number,
      closeTime: this.closeTime[i] as number,
      open: this.open[i] as number,
      high: this.high[i] as number,
      low: this.low[i] as number,
      close: this.close[i] as number,
      volume: this.volume[i] as number,
      quoteVolume: this.quoteVolume[i] as number,
      closed: this.closed[i] === 1,
    }
  }

  toArray(): Candle[] {
    return Array.from({ length: this.length }, (_, i) => this.at(i))
  }

  // Índice de la última vela con `openTime ≤ t`, o −1.
  lastIndexAtOrBefore(t: number): number {
    let lo = 0
    let hi = this.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if ((this.openTime[mid] as number) <= t) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  // Índice de la vela que abre en `openTime`, o −1.
  indexOf(openTime: number): number {
    const i = this.lastIndexAtOrBefore(openTime)
    return i >= 0 && this.openTime[i] === openTime ? i : -1
  }

  // Las velas desde el índice `start`, en arreglos propios (una vista compartida
  // retendría la serie entera).
  from(start: number): PackedCandles {
    if (start <= 0) return this
    const s = Math.min(start, this.length)
    return new PackedCandles(
      this.openTime.slice(s),
      this.closeTime.slice(s),
      this.open.slice(s),
      this.high.slice(s),
      this.low.slice(s),
      this.close.slice(s),
      this.volume.slice(s),
      this.quoteVolume.slice(s),
      this.closed.slice(s),
    )
  }
}

// Velas de último precio o de marca de un replay: como objetos o en columnas.
export type CandleList = readonly Candle[] | PackedCandles

export function packed(candles: CandleList): PackedCandles {
  return candles instanceof PackedCandles ? candles : PackedCandles.from(candles)
}

// Las velas cerradas con `closeTime ≤ t` de una serie, con la misma regla que
// `CandleSeries.closedUpTo`, materializando los objetos sólo cuando se piden. Las velas
// pedidas hace poco se guardan para devolver los mismos objetos (las vistas de instantes
// seguidos comparten casi todas sus velas) sin retener la serie entera como objetos.
const CACHE_SIZE = 512

export class PackedSeries {
  private cache: Candle[] | null = null
  private cachedIndex: Int32Array | null = null

  constructor(readonly candles: PackedCandles) {}

  get size(): number {
    return this.candles.length
  }

  candle(i: number): Candle {
    const slot = i % CACHE_SIZE
    if (this.cache === null || this.cachedIndex === null) {
      this.cache = new Array<Candle>(CACHE_SIZE)
      this.cachedIndex = new Int32Array(CACHE_SIZE).fill(-1)
    }
    if (this.cachedIndex[slot] === i) return this.cache[slot] as Candle
    const c = this.candles.at(i)
    this.cache[slot] = c
    this.cachedIndex[slot] = i
    return c
  }

  // La vela que abre en `openTime`, si está.
  get(openTime: number): Candle | undefined {
    const i = this.candles.indexOf(openTime)
    return i < 0 ? undefined : this.candle(i)
  }

  has(openTime: number): boolean {
    return this.candles.indexOf(openTime) >= 0
  }

  closedUpTo(t: number, limit = Number.POSITIVE_INFINITY): Candle[] {
    const { closed, closeTime } = this.candles
    const out: Candle[] = []
    for (let i = this.candles.lastIndexAtOrBefore(t); i >= 0 && out.length < limit; i--) {
      if (closed[i] === 1 && (closeTime[i] as number) <= t) out.push(this.candle(i))
    }
    return out.reverse()
  }
}
