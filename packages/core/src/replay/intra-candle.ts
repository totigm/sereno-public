import { crossedExit, nextStop, stopCloseReason, type ExitRules } from '../engine/exits'
import { bankruptcyPrice, liquidationCrossed, pastBankruptcy } from '../exchange/triggers'
import type { Candle, CloseReason, Position, Side } from '../types'

// Orden canónico dentro de una vela de replay (spec §6): apertura → si abre más allá del
// stop o de la liquidación, fill en la apertura → extremo adverso (stop, liquidación) →
// extremo favorable (take profit, trailing, breakeven) → cierre. Es el peor caso: el
// trailing nunca sube con el máximo antes de haber mirado el mínimo de la misma vela.
//
// La vela se recorre como una poligonal entre esos cuatro vértices, a la vez con la vela
// de precio de marca (dispara stops, take profit y liquidación) y con la de último precio
// (da el precio del fill). Un nivel que la marca cruza dentro de un tramo se toca en su
// punto exacto del tramo, y el último precio de ese punto se interpola en la misma
// fracción: así un stop tocado sin gap llena en el stop y no en el extremo de la vela, y
// la liquidación, que está más lejos que el stop, nunca le gana a un stop sin gap.
//
// `resolveCandle` es el enunciado puro de ese orden para una posición. El replay no lo
// usa para cerrar: lleva al motor por los mismos puntos (`candle-player`), así las
// salidas del replay son las del motor, y un test exige que ambos coincidan.

export type CandlePhase = 'open' | 'adverse' | 'favorable' | 'close'
export const CANDLE_PHASES = ['open', 'adverse', 'favorable', 'close'] as const satisfies readonly CandlePhase[]

export interface PricePoint {
  mark: number
  last: number
}

export type CandlePath = Record<CandlePhase, PricePoint>

export interface CandleOutcome {
  closedBy: CloseReason | null
  // Precio de referencia del fill, antes de spread, slippage y comisión (el último precio
  // del punto donde disparó, o el precio de quiebra en una liquidación). null si no cerró.
  exitPrice: number | null
  // Stop y mejor precio al terminar la vela, o al cerrar si cerró.
  newStop: number
  newBest: number
  trailingActive: boolean
}

// Los cuatro vértices de la vela para una posición de ese lado: el extremo adverso de un
// long es el mínimo y el de un short, el máximo.
export function canonicalPath(side: Side, last: Candle, mark: Candle): CandlePath {
  const low = { mark: mark.low, last: last.low }
  const high = { mark: mark.high, last: last.high }
  return {
    open: { mark: mark.open, last: last.open },
    adverse: side === 'long' ? low : high,
    favorable: side === 'long' ? high : low,
    close: { mark: mark.close, last: last.close },
  }
}

// Los puntos del tramo `from → to` donde la marca cruza alguno de los niveles (sin los
// extremos: el de partida ya se visitó y el de llegada es el vértice), en el orden en que
// el camino los toca, y al final el vértice `to`.
export function segmentPoints(from: PricePoint, to: PricePoint, levels: readonly number[]): PricePoint[] {
  const lo = Math.min(from.mark, to.mark)
  const hi = Math.max(from.mark, to.mark)
  const falling = to.mark < from.mark
  const crossed = [...new Set(levels)].filter((level) => level > lo && level < hi).sort((a, b) => (falling ? b - a : a - b))
  // La razón va primero: si las dos velas coinciden vale 1 exacto y el último queda en el nivel.
  const ratio = (to.last - from.last) / (to.mark - from.mark)
  return [...crossed.map((level) => ({ mark: level, last: from.last + (level - from.mark) * ratio })), to]
}

// Precios en los que una posición puede cambiar: stop, liquidación y take profit.
export function positionLevels(p: Pick<Position, 'stopPrice' | 'liquidationPrice' | 'takeProfitPrice'>): number[] {
  return p.takeProfitPrice === null ? [p.stopPrice, p.liquidationPrice] : [p.stopPrice, p.liquidationPrice, p.takeProfitPrice]
}

type Visit = { closedBy: CloseReason; exitPrice: number } | null

export function resolveCandle(position: Position, lastCandle: Candle, markCandle: Candle, exits: ExitRules): CandleOutcome {
  const p: Position = { ...position }
  const path = canonicalPath(p.side, lastCandle, markCandle)
  const outcome = (closed: Visit): CandleOutcome => ({
    closedBy: closed?.closedBy ?? null,
    exitPrice: closed?.exitPrice ?? null,
    newStop: p.stopPrice,
    newBest: p.bestPrice,
    trailingActive: p.trailingActive,
  })

  const opened = visit(p, path.open, exits)
  if (opened) return outcome(opened)
  let from = path.open
  for (const phase of CANDLE_PHASES.slice(1)) {
    const to = path[phase]
    for (const point of segmentPoints(from, to, positionLevels(p))) {
      const closed = visit(p, point, exits)
      if (closed) return outcome(closed)
    }
    from = to
  }
  return outcome(null)
}

// Un punto del camino, como lo procesa el motor con un tick: primero la liquidación (la
// resuelve el exchange antes que las órdenes), después stop o take profit, y si sigue
// abierta, el mejor precio y el trailing. Muta `p` (la copia de `resolveCandle`).
function visit(p: Position, point: PricePoint, exits: ExitRules): Visit {
  const bankruptcy = bankruptcyPrice(p.side, p.entryPrice, p.margin, p.qty)
  if (liquidationCrossed(p.side, point.mark, p.liquidationPrice)) return { closedBy: 'liquidation', exitPrice: bankruptcy }
  const crossed = crossedExit(p, point.mark)
  if (crossed !== null) {
    // En margen aislado una salida nunca pasa el precio de quiebra (el exchange la acota ahí).
    const exitPrice = pastBankruptcy(p.side, point.last, bankruptcy) ? bankruptcy : point.last
    return { closedBy: crossed === 'stop' ? stopCloseReason(p) : 'take_profit', exitPrice }
  }
  p.bestPrice = p.side === 'long' ? Math.max(p.bestPrice, point.mark) : Math.min(p.bestPrice, point.mark)
  const to = nextStop(p, point.mark, exits)
  if (to !== null) {
    p.stopPrice = to
    p.trailingActive = true
  }
  return null
}
