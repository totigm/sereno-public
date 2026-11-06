import type { CloseReason, Side } from '@sereno/core'
import { coinName } from '@sereno/core/src/journal/coin-name'
import { formatLeverage, formatPrice } from '@sereno/core/src/journal/format'
import { EM_DASH, formatDateBA, formatNumber, formatTimeBA, MINUS, startOfDayBA } from '@/lib/format'

// Textos chicos de Posiciones y de la hoja de trade. Los precios usan el mismo
// formato que el diario (cuatro cifras significativas): "142,10", "0,0000118".

export { coinName, formatPrice }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** "Long 5x", "Short 3x". */
export function sideLabel(side: Side, leverage: number): string {
  return `${side === 'long' ? 'Long' : 'Short'} ${formatLeverage(leverage)}`
}

/** Cuánto lleva o duró: "20 min", "3 h", "30 h", "3 días" (truncado, como la antigüedad del diario). */
export function durationLabel(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))} min`
  if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h`
  return `${Math.floor(ms / (24 * HOUR_MS))} días`
}

/**
 * Un resultado en dos partes, para poder separar la unidad: el signo ("+", "−", o nada si
 * redondea a cero, como en los montos) y el monto sin signo ("12,40").
 */
export function resultParts(n: number): { sign: '+' | typeof MINUS | ''; magnitude: string } {
  if (!Number.isFinite(n)) return { sign: '', magnitude: EM_DASH }
  // El redondeo de Intl es simétrico (la mitad va lejos del cero): el monto de |n| es el de n.
  const magnitude = formatNumber(Math.abs(n), 2)
  if (magnitude === formatNumber(0, 2)) return { sign: '', magnitude }
  return { sign: n < 0 ? MINUS : '+', magnitude }
}

/** "+US$ 12,40". */
export function formatResult(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH
  const { sign, magnitude } = resultParts(n)
  return `${sign}US$ ${magnitude}`
}

/** Por qué cerró, corto, para listas y la hoja. */
export const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  stop: 'Stop',
  take_profit: 'Take profit',
  trailing_stop: 'Trailing stop',
  signal_flip: 'Señales en contra',
  time_exit: 'Por tiempo',
  liquidation: 'Liquidada',
  manual: 'La cerraste vos',
  close_all: 'Cerrar todo',
  shield_reduce: 'Blindaje',
  delisted: 'Contrato deslistado',
  stop_missed_offline: 'Stop sin conexión',
  session_archived: 'Al archivar',
  loss_floor: 'Tope de pérdida',
  closed_on_exchange: 'Cerrada en Binance',
  unprotected: 'Sin stop: cerrada',
}

// `clock` es el reloj para "hoy" y "ayer" (`TradeScope.clock`): null en una sesión
// terminada, donde las fechas van completas.
type Relative = 'today' | 'yesterday' | null

function relativeDay(at: number, clock: number | null): Relative {
  if (clock === null) return null
  const day = startOfDayBA(at)
  const today = startOfDayBA(clock)
  if (day === today) return 'today'
  return day === startOfDayBA(today - 1) ? 'yesterday' : null
}

/** El encabezado de un día del historial: "Hoy", "Ayer", "29 de octubre". */
export function dayLabel(day: number, clock: number | null): string {
  const relative = relativeDay(day, clock)
  return relative === 'today' ? 'Hoy' : relative === 'yesterday' ? 'Ayer' : formatDateBA(day)
}

/** Un instante en la línea de tiempo: "14:32" hoy, "ayer 23:50", "29 de octubre 9:05". */
export function momentLabel(at: number, clock: number | null): string {
  const relative = relativeDay(at, clock)
  if (relative === 'today') return formatTimeBA(at)
  return `${relative === 'yesterday' ? 'ayer' : formatDateBA(at)} ${formatTimeBA(at)}`
}

/** Cuándo, en una frase: "hoy a las 03:00", "ayer a las 23:50", "el 30 de octubre a las 19:53". */
export function whenLabel(at: number, clock: number | null): string {
  const relative = relativeDay(at, clock)
  return `${relative === 'today' ? 'hoy' : relative === 'yesterday' ? 'ayer' : `el ${formatDateBA(at)}`} a las ${formatTimeBA(at)}`
}
