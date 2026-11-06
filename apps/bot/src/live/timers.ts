// Reloj y temporizadores del runtime. Se inyectan para que los tests manejen el tiempo
// (los cierres de vela, el plazo de 3 s, el latido) sin esperar de verdad.

export type TimerHandle = unknown

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export interface Clock {
  now: () => number
  timers: Timers
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const realClock: Clock = { now: Date.now, timers: realTimers }
