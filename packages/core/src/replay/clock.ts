// Tiempo del replay: un reloj simulado que sólo avanza y el calendario en UTC de las
// velas, del universo diario y del ajuste semanal de parámetros.

export const MINUTE_MS = 60_000
export const CANDLE_MS = 15 * MINUTE_MS
export const DAY_MS = 24 * 60 * MINUTE_MS
// Ajuste semanal de parámetros: domingos a las 00:30 UTC (spec §8.3).
const TUNING_TIME_OF_DAY = 30 * MINUTE_MS
const SUNDAY = 0

export class SimClock {
  private current: number

  constructor(start: number) {
    this.current = start
  }

  get now(): number {
    return this.current
  }

  // Volver atrás haría que un cierre quede antes que su apertura o que un enfriamiento
  // termine dos veces: es un error del replay, no algo que se pueda tolerar.
  advance(t: number): void {
    if (!(t >= this.current)) throw new RangeError(`el reloj del replay no retrocede: ${t} < ${this.current}`)
    this.current = t
  }
}

// Día UTC (`YYYY-MM-DD`) de un instante: la clave del universo diario.
export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

export function isParamTuningSlot(t: number): boolean {
  return t % DAY_MS === TUNING_TIME_OF_DAY && new Date(t).getUTCDay() === SUNDAY
}
