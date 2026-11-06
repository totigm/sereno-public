import { BA_TZ } from '@/lib/format'
import type { SessionView } from '@/lib/queries/session'

// Cómo se nombra una sesión en el chip y en la banda de contexto (spec §11.1).

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const

const partsFormat = new Intl.DateTimeFormat('en-US', { timeZone: BA_TZ, year: 'numeric', month: 'numeric', day: 'numeric' })

function dayBA(at: number): { year: number; month: number; day: number } {
  const out = { year: 0, month: 0, day: 0 }
  for (const part of partsFormat.formatToParts(at)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') out[part.type] = Number(part.value)
  }
  return out
}

/** `"2 ago"` (día de Buenos Aires); con año si se pide. Abreviatura propia: Intl le agrega punto según la versión de ICU. */
function shortDate(at: number, withYear: boolean): string {
  const { year, month, day } = dayBA(at)
  return `${day} ${MONTHS[month - 1] ?? ''}${withYear ? ` ${year}` : ''}`
}

/** `"2 ago → 31 oct"`; el año aparece sólo si el tramo cruza de un año a otro. */
function periodLabel(from: number, to: number | null): string {
  if (to === null) return shortDate(from, false)
  const withYear = dayBA(from).year !== dayBA(to).year
  return `${shortDate(from, withYear)} → ${shortDate(to, withYear)}`
}

function replayDays(session: SessionView): number {
  return session.replayParams?.days ?? Math.round(session.days)
}

function daysLabel(days: number): string {
  return `${days} ${days === 1 ? 'día' : 'días'}`
}

/** El chip junto al nombre: "Simulado", "Replay · 90 días" o "Plata real". */
export function sessionChipLabel(session: SessionView): string {
  if (session.kind === 'replay') return `Replay · ${daysLabel(replayDays(session))}`
  return session.kind === 'live' ? 'Plata real' : 'Simulado'
}

/**
 * La banda de contexto: "Replay · 90 días · 2 ago → 31 oct", "Simulación archivada · 14 oct
 * → 20 oct" o, de una sesión con plata real ya cerrada, "Plata real archivada · …".
 */
export function contextBandLabel(session: SessionView): string {
  const period = periodLabel(session.period.from, session.period.to)
  if (session.kind === 'replay') return `${sessionChipLabel(session)} · ${period}`
  return `${session.kind === 'live' ? 'Plata real archivada' : 'Simulación archivada'} · ${period}`
}

const REPLAY_STATUS: Partial<Record<SessionView['status'], string>> = {
  en_cola: 'En cola',
  descargando: 'Descargando datos',
  simulando: 'Simulando',
  fallido: 'No pudo terminar',
  cancelado: 'Cancelado',
}

/** Un replay que no terminó bien dice en qué está (el mensaje del bot si lo hay); uno listo, nada. */
export function replayStatusLabel(session: SessionView): string | null {
  if (session.kind !== 'replay' || session.status === 'listo') return null
  const running = session.status === 'descargando' || session.status === 'simulando'
  if (running && session.mensaje) return session.mensaje
  return REPLAY_STATUS[session.status] ?? null
}
