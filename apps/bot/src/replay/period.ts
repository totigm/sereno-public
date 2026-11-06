// Calendario de un replay: el período que cubren los días pedidos y los días UTC que toca.

import { CANDLE_MS, DAY_MS } from '@sereno/core/src/replay/clock'

export interface Period {
  // [from, to), en ms UTC y alineado a velas de 15m.
  from: number
  to: number
}

// Días UTC completos que terminan donde empieza hoy: "día 41 de 90" es un día entero y
// todas las velas del período ya cerraron (no cambian entre un replay y el siguiente).
export function replayPeriod(days: number, now: number): Period {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`replay: ${days} días no es un período válido`)
  const to = Math.floor(now / DAY_MS) * DAY_MS
  return { from: to - days * DAY_MS, to }
}

// Los últimos `days` días hasta la última vela de 15m cerrada (el walk-forward semanal).
export function trailingPeriod(days: number, now: number): Period {
  const to = Math.floor(now / CANDLE_MS) * CANDLE_MS
  return { from: to - days * DAY_MS, to }
}

// Inicio de cada día UTC que el período toca, en orden.
export function dayStarts({ from, to }: Period): number[] {
  const out: number[] = []
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) out.push(day)
  return out
}
