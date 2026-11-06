import type { SignalId } from '@sereno/core'
import { SIGNAL_NAMES } from '@sereno/core/src/journal/phrases'
import type { ReplayParams } from '@sereno/db'
import { BA_TZ, formatDateBA, formatNumber, formatSigned, formatTimeBA, formatUsd, startOfDayBA } from '@/lib/format'

// Textos chicos de la pantalla Aprendizaje: nombres de señales para tablas, fechas
// cortas del diario y resúmenes de un replay. Puros: los usa el servidor y el cliente.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const
const ARTICLE = /^(?:el|la|los|las) /

const dayParts = new Intl.DateTimeFormat('en-US', { timeZone: BA_TZ, year: 'numeric', month: 'numeric', day: 'numeric' })

function dayBA(at: number): { year: number; month: number; day: number } {
  const out = { year: 0, month: 0, day: 0 }
  for (const part of dayParts.formatToParts(at)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') out[part.type] = Number(part.value)
  }
  return out
}

/** "La tendencia mayor" → "Tendencia mayor", "el VWAP" → "VWAP": el nombre como encabezado de fila. */
export function signalLabel(id: SignalId): string {
  const bare = SIGNAL_NAMES[id].replace(ARTICLE, '')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/** `"28 oct"` (día de Buenos Aires), con año si no es el de `now`. Abreviatura propia: Intl le agrega punto según la versión de ICU. */
export function shortDate(at: number, now: number): string {
  const { year, month, day } = dayBA(at)
  return `${day} ${MONTHS[month - 1] ?? ''}${year === dayBA(now).year ? '' : ` ${year}`}`
}

/** `"2 ago → 31 oct"`: el tramo de mercado de una sesión (hasta `now` si sigue). */
export function periodLabel(period: { from: number; to: number | null }, now: number): string {
  return `${shortDate(period.from, now)} → ${shortDate(period.to ?? now, now)}`
}

/** La columna de hora del diario: `"14:32"` hoy, `"ayer"`, y `"28 oct"` antes. */
export function journalWhen(at: number, now: number): string {
  const day = startOfDayBA(at)
  const today = startOfDayBA(now)
  if (day === today) return formatTimeBA(at)
  if (day === startOfDayBA(today - 1)) return 'ayer'
  return shortDate(at, now)
}

/** El encabezado de un día en el diario completo: "Hoy", "Ayer", "28 de octubre". */
export function dayHeading(day: number, now: number): string {
  const today = startOfDayBA(now)
  if (day === today) return 'Hoy'
  if (day === startOfDayBA(today - 1)) return 'Ayer'
  const year = dayBA(day).year
  return `${formatDateBA(day)}${year === dayBA(now).year ? '' : ` de ${year}`}`
}

/** "el 14 de octubre", "hoy a las 10:15" o "ayer": cuándo cambió algo, dentro de una frase. */
export function whenPhrase(at: number, now: number): string {
  const day = startOfDayBA(at)
  const today = startOfDayBA(now)
  if (day === today) return `hoy a las ${formatTimeBA(at)}`
  if (day === startOfDayBA(today - 1)) return 'ayer'
  const year = dayBA(at).year
  return `el ${formatDateBA(at)}${year === dayBA(now).year ? '' : ` de ${year}`}`
}

/** `"+6,7R"`, `"−1,2R"`. */
export function formatSumR(r: number): string {
  return `${formatSigned(r, 1)}R`
}

/** Un múltiplo de R sin signo y sin ceros de más: `"2R"`, `"1,5R"`, `"0,75R"`. */
export function formatPlainR(r: number): string {
  return `${formatNumber(r, Number.isInteger(r) ? 0 : r * 10 === Math.round(r * 10) ? 1 : 2)}R`
}

/** "90 días · US$ 1.000 · desde cero · con ajuste de parámetros": cómo se pidió un replay. */
export function replayParamsLabel(params: ReplayParams): string {
  return [
    `${params.days} ${params.days === 1 ? 'día' : 'días'}`,
    formatUsd(params.capital).replace(/,00$/, ''),
    params.learningOrigin === 'zero' ? 'desde cero' : 'con lo aprendido',
    params.paramTuning ? 'con ajuste de parámetros' : 'sin ajuste de parámetros',
  ].join(' · ')
}

export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n, 0)} ${n === 1 ? one : many}`
}
