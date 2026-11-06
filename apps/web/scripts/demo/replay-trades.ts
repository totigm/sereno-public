import type { Side } from '@sereno/core'
import { DEMO_SETTINGS } from './settings'
import type { Coin } from './coins'
import { TRAIL_CROSS_R } from './plans'
import type { Rng } from './random'
import type { ExitSpec, TradeSpec } from './spec'
import { CYCLE_MS, HOUR_MS, utcDay } from './time'

// Los trades de un replay, inventados con la semilla: una mezcla de salidas parecida
// a la de una estrategia con algo de ventaja, sin violar las reglas que el libro
// comprueba (enfriamiento, racha de stops, pérdida diaria, capacidad, penitencia).

export interface ReplayTradesInput {
  rng: Rng
  // Los ids de los trades llevan el del replay: el mercado del escenario es compartido.
  idPrefix: string
  coins: readonly Coin[]
  start: number
  end: number
  // Abiertas que quedan al terminar.
  openAtEnd: number
}

// Dos a la vez: con el 1% de riesgo el margen de tres trades de BTC ya roza el tope.
const MAX_CONCURRENT = 2
const MAX_STOPS_PER_DAY = 2
const MAX_STOPS_IN_A_ROW = 3
// Una moneda descansa dos horas después de cerrar: más que el enfriamiento.
const REST_MS = 2 * HOUR_MS
const TIME_EXIT_MS = DEMO_SETTINGS.exits.timeExitHours * HOUR_MS

// La confianza de cada moneda como la lleva el aprendizaje (EMA de clamp(R)/2, spec §8),
// estimada con un R pesimista: un trade que la bajaría de CONFIDENCE_FLOOR sale por
// take profit. Así ninguna moneda cae en penitencia entre trades ya decididos y su
// multiplicador (1 + confianza) no achica el tamaño por debajo del contrato mínimo.
const { confidenceAlpha, penaltyThreshold } = DEMO_SETTINGS.learning
const CONFIDENCE_FLOOR = penaltyThreshold + 0.15
// Comisiones, spread y slippage de ida y vuelta, en R y de más.
const COST_R = 0.2

type Kind = 'take_profit' | 'stop' | 'trailing_stop' | 'signal_flip' | 'time_exit'

const MIX: readonly [Kind, number][] = [
  ['take_profit', 0.33],
  ['stop', 0.37],
  ['trailing_stop', 0.13],
  ['signal_flip', 0.11],
  ['time_exit', 0.06],
]

const cycles = (rng: Rng, loHours: number, hiHours: number): number => rng.int(loHours * 4, hiHours * 4) * CYCLE_MS

function pickKind(rng: Rng): Kind {
  let u = rng.next()
  for (const [kind, weight] of MIX) {
    if (u < weight) return kind
    u -= weight
  }
  return 'take_profit'
}

function exitFor(kind: Kind, rng: Rng, open: number): ExitSpec {
  switch (kind) {
    case 'take_profit':
      return { kind, at: open + cycles(rng, 4, 20) }
    case 'stop':
      return { kind, at: open + cycles(rng, 2, 12) }
    case 'trailing_stop': {
      const peakAt = open + cycles(rng, 3, 12)
      return { kind, peakAt, at: peakAt + cycles(rng, 2, 10), peakR: rng.between(1.25, 1.85) }
    }
    case 'signal_flip':
      return { kind: 'market', reason: 'signal_flip', at: open + cycles(rng, 3, 16), r: rng.between(-0.4, 0.8) }
    case 'time_exit':
      return { kind, r: rng.between(-0.3, 0.25) }
  }
}

function pessimisticR(exit: ExitSpec): number {
  const { tpR, trailingR } = DEMO_SETTINGS.exits
  switch (exit.kind) {
    case 'stop':
      return -1 - COST_R
    case 'take_profit':
      return tpR - COST_R
    case 'trailing_stop':
      return exit.peakR - trailingR - TRAIL_CROSS_R - COST_R
    case 'market':
    case 'time_exit':
    case 'open':
      return exit.r - COST_R
  }
}

function confidenceAfter(before: number, exit: ExitSpec): number {
  const r = Math.max(-2, Math.min(2, pessimisticR(exit))) / 2
  return before + confidenceAlpha * (r - before)
}

function exitTime(exit: ExitSpec, open: number): number {
  return exit.kind === 'time_exit' ? open + TIME_EXIT_MS : exit.kind === 'open' ? Number.POSITIVE_INFINITY : exit.at
}

export function replayTrades({ rng, idPrefix, coins, start, end, openAtEnd }: ReplayTradesInput): TradeSpec[] {
  const trades: TradeSpec[] = []
  const busyUntil = new Map<string, number>()
  const stopsByDay = new Map<string, number>()
  const closes: number[] = []
  const confidence = new Map<string, number>()
  let stopsInARow = 0
  const free = (t: number): Coin[] => coins.filter((c) => (busyUntil.get(c.symbol) ?? 0) <= t)
  const concurrent = (t: number): number => closes.filter((c) => c > t).length
  const add = (coin: Coin, side: Side, open: number, exit: ExitSpec): void => {
    trades.push({ id: `${idPrefix}${String(trades.length + 1).padStart(3, '0')}`, symbol: coin.symbol, side, open, exit, strength: rng.between(0.36, 0.7), until: end })
    const close = exitTime(exit, open)
    closes.push(close)
    busyUntil.set(coin.symbol, close + REST_MS)
  }

  // Todo lo que abre antes cierra antes de las abiertas del final.
  const lastOpenAt = end - TIME_EXIT_MS - (openAtEnd + 1) * 3 * HOUR_MS
  for (let t = start + 6 * HOUR_MS; t < lastOpenAt; t += cycles(rng, 6, 26)) {
    const candidates = free(t)
    if (candidates.length === 0 || concurrent(t) >= MAX_CONCURRENT) continue
    let kind = pickKind(rng)
    const coin = rng.pick(candidates)
    let exit = exitFor(kind, rng, t)
    const trust = confidence.get(coin.symbol) ?? 0
    const day = utcDay(exitTime(exit, t))
    const tooManyStops = kind === 'stop' && ((stopsByDay.get(day) ?? 0) >= MAX_STOPS_PER_DAY || stopsInARow >= MAX_STOPS_IN_A_ROW)
    if (tooManyStops || confidenceAfter(trust, exit) < CONFIDENCE_FLOOR) {
      kind = 'take_profit'
      exit = exitFor(kind, rng, t)
    }
    if (kind === 'stop') stopsByDay.set(day, (stopsByDay.get(day) ?? 0) + 1)
    stopsInARow = kind === 'stop' ? stopsInARow + 1 : 0
    confidence.set(coin.symbol, confidenceAfter(trust, exit))
    add(coin, rng.next() < 0.5 ? 'long' : 'short', t, exit)
  }

  // Las últimas abren cerca del final y siguen abiertas.
  for (let i = 0; i < openAtEnd; i++) {
    const t = end - (openAtEnd - i) * 3 * HOUR_MS - CYCLE_MS * rng.int(0, 4)
    const coin = rng.pick(free(t))
    add(coin, rng.next() < 0.5 ? 'long' : 'short', t, { kind: 'open', r: rng.between(-0.5, 0.9) })
  }
  return trades
}
