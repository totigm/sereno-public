import type { Candle, MarkTick } from '../types'
import { CANDLE_MS, MINUTE_MS } from './clock'
import { CANDLE_PHASES, canonicalPath, segmentPoints, type CandlePath, type CandlePhase, type PricePoint } from './intra-candle'
import type { Lane } from './lane'

// Lleva al motor por el camino canónico de una vela (ver `intra-candle`) con ticks
// sintéticos de marca: las salidas, el trailing, la liquidación y el blindaje del replay
// son los del motor, sin una copia de esas reglas. Toda la cartera recorre la vela en
// fases: primero todas las monedas van a su extremo adverso (el peor momento posible de
// la cartera), después al favorable y al cierre.
//
// La excepción a ese peor caso: el motor evalúa el blindaje en cada tick, y al terminar
// la fase favorable toda la cartera está en su extremo favorable a la vez, un momento que
// pudo no existir. Como el blindaje mira min(realizado, realizado + no realizado), ese
// momento sólo lo adelanta si las abiertas, sumadas, pierden fuera de él; si se dispara
// ahí con `reducir`, cierra a precios del extremo favorable. Limitarlo a los cierres de
// vela pediría cambiar el motor (`markTick` evalúa el blindaje con cada tick).

export interface CandleFeed {
  last: Candle
  mark: Candle
}

// Instantes convencionales de cada vértice: con velas de 15 minutos el momento real del
// mínimo o del máximo no se conoce. Sólo importa que avancen y queden dentro de la vela.
export const PHASE_OFFSET: Record<CandlePhase, number> = {
  open: 0,
  adverse: 5 * MINUTE_MS,
  favorable: 10 * MINUTE_MS,
  close: CANDLE_MS - 1,
}

export interface PlayOptions {
  // En el replay la apertura ya la procesó el ciclo de decisión (es el precio de su
  // vista): el reproductor arranca en el tramo hacia el extremo adverso.
  fromOpen: boolean
  onPhase?: (phase: CandlePhase) => void
  // Una moneda que se recorre con la sombra del lado contrario a lo real (ver `LevelBook`).
  onOpposed?: (symbol: string) => void
}

export async function playCandle(lane: Lane, slot: number, feeds: ReadonlyMap<string, CandleFeed>, options: PlayOptions): Promise<void> {
  const paths = new Map<string, CandlePath>()
  for (const symbol of [...feeds.keys()].sort()) {
    const feed = feeds.get(symbol)
    if (!feed || !lane.levels.has(symbol)) continue
    paths.set(symbol, canonicalPath(lane.levels.pathSide(symbol), feed.last, feed.mark))
    if (lane.levels.opposed(symbol)) options.onOpposed?.(symbol)
  }
  for (const phase of options.fromOpen ? CANDLE_PHASES : CANDLE_PHASES.slice(1)) {
    lane.clock.advance(slot + PHASE_OFFSET[phase])
    for (const [symbol, path] of paths) {
      if (!lane.levels.has(symbol)) continue
      for (const point of pointsOf(path, phase, lane.levels.levels(symbol))) await lane.engine.onMarkTick(tickOf(symbol, point, lane.clock.now))
    }
    options.onPhase?.(phase)
  }
}

function pointsOf(path: CandlePath, phase: CandlePhase, levels: readonly number[]): PricePoint[] {
  const index = CANDLE_PHASES.indexOf(phase)
  const previous = CANDLE_PHASES[index - 1]
  return previous === undefined ? [path[phase]] : segmentPoints(path[previous], path[phase], levels)
}

function tickOf(symbol: string, point: PricePoint, at: number): MarkTick {
  return { symbol, markPrice: point.mark, lastPrice: point.last, at, fundingRate: null, nextFundingTime: null }
}
