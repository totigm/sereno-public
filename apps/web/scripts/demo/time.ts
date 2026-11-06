export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const FOUR_HOURS_MS = 4 * HOUR_MS
// El ciclo del motor: cada cierre de vela de 15 minutos.
export const CYCLE_MS = 15 * MINUTE_MS

// Lo que tarda el bot en ejecutar lo que decidió un ciclo: la entrada sale entre 0,9 y
// 1,8 s después del cierre y un cierre a mercado entre 2 y 3,2 s.
export const OPEN_LATENCY_MS = { min: 900, max: 1800 } as const
export const CLOSE_LATENCY_MS = { min: 2000, max: 3200 } as const
// A los 5 s del cierre un ciclo ya ejecutó sus órdenes y escribió sus filas.
export const CYCLE_SETTLE_MS = 5 * SECOND_MS
// Una moneda queda degradada cuando pasa más de un minuto sin datos (STALE_DATA_MS
// de apps/bot/src/live/session-market.ts).
export const STALE_DATA_MS = MINUTE_MS

export function alignDown(t: number, step: number): number {
  return Math.floor(t / step) * step
}

// El último ciclo que terminó antes de `at`: si el bot escribió por última vez justo
// después de un cierre, ese ciclo todavía estaba ejecutando y no dejó nada guardado.
export function lastSettledCycle(at: number): number {
  return alignDown(at - CYCLE_SETTLE_MS, CYCLE_MS)
}

// "2026-10-31" en UTC, como la columna `universe_days.day`.
export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}
