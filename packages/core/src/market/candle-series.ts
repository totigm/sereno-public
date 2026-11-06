import type { Candle, Timeframe } from '../types'
import { lastIndexAtOrBefore } from './search'

const byOpenTime = (c: Candle): number => c.openTime

// Lo que las vistas leen de una serie: `CandleSeries` o, en el replay, `PackedSeries`.
export interface ClosedCandles {
  closedUpTo(t: number, limit?: number): Candle[]
}

// Serie de velas de un marco, ordenada por `openTime` y única por `openTime`.
// `closedUpTo` es la regla de causalidad de la spec §5.2: el motor sólo ve velas
// cerradas cuyo `closeTime ≤ t`, tanto en vivo (la vela abierta llega con `closed: false`)
// como en replay (la serie ya contiene velas futuras, todas cerradas).
export class CandleSeries {
  private readonly candles: Candle[] = []

  constructor(readonly tf: Timeframe) {}

  get size(): number {
    return this.candles.length
  }

  /**
   * Reemplaza la vela del mismo `openTime` (en vivo la vela abierta se actualiza con cada
   * tick hasta cerrar) o la inserta en su lugar si llega desordenada. Agregar al final es
   * O(log n); insertar en el medio desplaza el arreglo (O(n)), así que quien carga historia
   * tiene que hacerlo en orden creciente: de lo más nuevo a lo más viejo sería O(n²).
   */
  upsert(c: Candle): void {
    const i = lastIndexAtOrBefore(this.candles, byOpenTime, c.openTime)
    if (i >= 0 && this.candles[i]?.openTime === c.openTime) {
      this.candles[i] = c
    } else {
      this.candles.splice(i + 1, 0, c)
    }
  }

  // Las últimas `limit` velas con `closed && closeTime ≤ t`, en orden cronológico.
  // Una vela que abrió después de `t` no pudo cerrar antes de `t`, así que se arranca
  // desde la última que abrió ≤ t y se recorre hacia atrás; cada vela se comprueba
  // igual contra la regla completa.
  closedUpTo(t: number, limit = Number.POSITIVE_INFINITY): Candle[] {
    const out: Candle[] = []
    for (let i = lastIndexAtOrBefore(this.candles, byOpenTime, t); i >= 0 && out.length < limit; i--) {
      const c = this.candles[i]
      if (c !== undefined && c.closed && c.closeTime <= t) out.push(c)
    }
    return out.reverse()
  }

  // La última vela de la serie, esté cerrada o no.
  last(): Candle | undefined {
    return this.candles.at(-1)
  }
}
