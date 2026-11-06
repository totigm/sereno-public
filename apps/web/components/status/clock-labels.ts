import { formatDateBA, formatTimeBA, startOfDayBA } from '@/lib/format'

/**
 * Desde cuándo, para frases como "sin conexión desde …" o "pausado desde …":
 * `"las 14:32"` hoy, `"ayer a las 23:50"`, y `"el 14 de octubre a las 9:05"` antes.
 */
export function sinceClock(at: number, now: number): string {
  const day = startOfDayBA(at)
  const today = startOfDayBA(now)
  if (day === today) return `las ${formatTimeBA(at)}`
  if (day === startOfDayBA(today - 1)) return `ayer a las ${formatTimeBA(at)}`
  return `el ${formatDateBA(at)} a las ${formatTimeBA(at)}`
}
