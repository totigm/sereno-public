// Fechas y horas para mostrar en hora de Buenos Aires. El proceso corre en UTC,
// así que todo pasa por Intl con timeZone explícito y nunca por la zona local.

export const BA_TZ = 'America/Argentina/Buenos_Aires'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BA_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})
const timeFormat = new Intl.DateTimeFormat('es-AR', { timeZone: BA_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('es-AR', { timeZone: BA_TZ, day: 'numeric', month: 'long' })

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClockBA(at: number): WallClock {
  const wall: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of partsFormat.formatToParts(at)) {
    if (part.type in wall) wall[part.type as keyof WallClock] = Number(part.value)
  }
  return wall
}

/** Diferencia entre la hora de pared de BA y UTC en ese instante (−3 h hoy). */
function offsetBA(at: number): number {
  const w = wallClockBA(at)
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // La hora de pared tiene resolución de segundos: se compara contra `at` truncado igual.
  return wallAsUtc - Math.floor(at / 1000) * 1000
}

/** Instante de las 00:00 en Buenos Aires del día calendario (de BA) que contiene `at`. */
export function startOfDayBA(at: number): number {
  const { year, month, day } = wallClockBA(at)
  const midnightAsUtc = Date.UTC(year, month - 1, day)
  // Argentina no tiene horario de verano hoy, pero si volviera el offset de la
  // medianoche podría diferir del de `at`: se recalcula sobre la estimación.
  const estimate = midnightAsUtc - offsetBA(at)
  return midnightAsUtc - offsetBA(estimate)
}

/** `"14:32"` (24 h, hora de BA). */
export function formatTimeBA(at: number): string {
  return timeFormat.format(at)
}

/** `"14 de octubre"` (día de BA). */
export function formatDateBA(at: number): string {
  return dateFormat.format(at)
}

/** Desde cuándo: `"hoy a las 10:15"`, `"ayer"`, `"el 14 de octubre"` (con año si no es el actual). */
export function sinceLabel(startedAt: number, now: number): string {
  const day = startOfDayBA(startedAt)
  const today = startOfDayBA(now)
  if (day === today) return `hoy a las ${formatTimeBA(startedAt)}`
  if (day === startOfDayBA(today - 1)) return 'ayer'
  const year = wallClockBA(startedAt).year
  const suffix = year === wallClockBA(now).year ? '' : ` de ${year}`
  return `el ${formatDateBA(startedAt)}${suffix}`
}

/** Antigüedad aproximada, truncada: `"hace 20 min"`, `"hace 3 h"`, `"hace 2 días"`; menos de un minuto es `"recién"`. */
export function relativeAge(at: number, now: number): string {
  const elapsed = now - at
  if (elapsed < MINUTE_MS) return 'recién'
  if (elapsed < HOUR_MS) return `hace ${Math.floor(elapsed / MINUTE_MS)} min`
  if (elapsed < DAY_MS) return `hace ${Math.floor(elapsed / HOUR_MS)} h`
  const days = Math.floor(elapsed / DAY_MS)
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`
}
