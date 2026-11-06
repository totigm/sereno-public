import { liquidationPrice } from '../../src/risk/liquidation'
import type { Candle, CloseReason, Position } from '../../src/types'
import { positionOf, T } from '../engine/fixtures'

// Casos del orden canónico intra-vela (spec §6, brief de Task 13). Los usan el test
// puro de `resolveCandle` y el que corre los mismos casos por el motor.

const MIN15 = 15 * 60_000

export interface Ohlc {
  o: number
  h: number
  l: number
  c: number
}

export function candleOf({ o, h, l, c }: Ohlc, openTime = T): Candle {
  return { openTime, closeTime: openTime + MIN15 - 1, open: o, high: h, low: l, close: c, volume: 10, quoteVolume: 10 * c, closed: true }
}

export interface ExpectedOutcome {
  closedBy: CloseReason | null
  exitPrice: number | null
  newStop: number
  newBest: number
  trailingActive: boolean
}

export interface IntraCandleCase {
  name: string
  position: Position
  last: Candle
  // Vela de precio de marca; si falta, es la misma que la de último precio.
  mark?: Candle
  expected: ExpectedOutcome
}

// Long del brief: entrada 100, d 1% (1R = 1 de precio), stop 99, take profit 102.
// A 5x con 2 de cantidad la liquidación queda en 80,81 y la quiebra en 80.
const long = (overrides: Partial<Position> = {}) => positionOf('SOLUSDT', { takeProfitPrice: 102, ...overrides })

// El mismo trade del lado corto: stop 101, take profit 98.
const short = (overrides: Partial<Position> = {}) =>
  positionOf('SOLUSDT', {
    side: 'short',
    stopPrice: 101,
    takeProfitPrice: 98,
    liquidationPrice: liquidationPrice('short', 100, 5, 0.01),
    ...overrides,
  })

export const INTRA_CANDLE_CASES: IntraCandleCase[] = [
  {
    name: 'o 100 h 103 l 98,5 c 102 ⇒ stop (el adverso va primero) y el trailing no se activó',
    position: long(),
    last: candleOf({ o: 100, h: 103, l: 98.5, c: 102 }),
    expected: { closedBy: 'stop', exitPrice: 99, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'abre en 97, más allá del stop ⇒ fill en la apertura (gap)',
    position: long(),
    last: candleOf({ o: 97, h: 97.5, l: 96.5, c: 97.2 }),
    expected: { closedBy: 'stop', exitPrice: 97, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'o 100 h 103 l 99,5 ⇒ take profit en 102',
    position: long(),
    last: candleOf({ o: 100, h: 103, l: 99.5, c: 102.5 }),
    expected: { closedBy: 'take_profit', exitPrice: 102, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'trailing activo (mejor 103, stop 102) y vela h 104 l 101,5 ⇒ trailing_stop en 102 antes de subir el stop con el máximo',
    position: long({ stopPrice: 102, takeProfitPrice: 105, trailingActive: true, bestPrice: 103 }),
    last: candleOf({ o: 102.5, h: 104, l: 101.5, c: 103 }),
    expected: { closedBy: 'trailing_stop', exitPrice: 102, newStop: 102, newBest: 103, trailingActive: true },
  },
  {
    name: 'el máximo activa el trailing (+1R) y el cierre queda arriba del stop nuevo ⇒ sigue abierta',
    position: long(),
    last: candleOf({ o: 100, h: 101.8, l: 99.5, c: 101.2 }),
    expected: { closedBy: null, exitPrice: null, newStop: 100.8, newBest: 101.8, trailingActive: true },
  },
  {
    name: 'el stop que subió el máximo se toca bajando hacia el cierre ⇒ trailing_stop',
    position: long({ takeProfitPrice: null }),
    last: candleOf({ o: 100, h: 102.5, l: 99.5, c: 101 }),
    expected: { closedBy: 'trailing_stop', exitPrice: 101.5, newStop: 101.5, newBest: 102.5, trailingActive: true },
  },
  {
    name: 'un mínimo más allá de la liquidación sin gap ⇒ el stop, que está antes en el camino, cierra primero',
    position: long(),
    last: candleOf({ o: 100, h: 100.5, l: 79, c: 85 }),
    expected: { closedBy: 'stop', exitPrice: 99, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'abre más allá de la liquidación ⇒ liquidación al precio de quiebra',
    position: long(),
    last: candleOf({ o: 79, h: 81, l: 78, c: 80 }),
    expected: { closedBy: 'liquidation', exitPrice: 80, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'short: el adverso es el máximo y va primero ⇒ stop en 101 aunque el mínimo toque el take profit',
    position: short(),
    last: candleOf({ o: 100, h: 101.5, l: 97, c: 98 }),
    expected: { closedBy: 'stop', exitPrice: 101, newStop: 101, newBest: 100, trailingActive: false },
  },
  {
    name: 'dispara la marca y llena el último: el fill es el último en el punto del tramo donde la marca tocó el stop',
    position: long(),
    last: candleOf({ o: 100, h: 100.6, l: 99.2, c: 99.6 }),
    mark: candleOf({ o: 100, h: 100.5, l: 98.8, c: 99.5 }),
    // La marca baja de 100 a 98,8 y toca 99 a 1/1,2 del tramo; el último va de 100 a 99,2.
    expected: { closedBy: 'stop', exitPrice: 100 - 0.8 / 1.2, newStop: 99, newBest: 100, trailingActive: false },
  },
  {
    name: 'el último cruza el stop pero la marca no ⇒ no dispara',
    position: long(),
    last: candleOf({ o: 100, h: 100.5, l: 98.5, c: 99.8 }),
    mark: candleOf({ o: 100, h: 100.4, l: 99.1, c: 99.8 }),
    // El mejor precio del trailing es el de marca: 100,4, no el 100,5 del último.
    expected: { closedBy: null, exitPrice: null, newStop: 99, newBest: 100.4, trailingActive: false },
  },
]
