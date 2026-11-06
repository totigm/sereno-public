import { formatUsd } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'

// Frases de Ajustes › Bot (spec §11.1), con el número de abiertas adentro.

function theOpen(count: number): string {
  return count === 1 ? 'la abierta' : `las ${count} abiertas`
}

/** "Vas a cerrar 3 posiciones por −US$ 8,40.": lo que dejaría cerrarlas ahora, si todas tienen precio. */
export function closeAllText(open: readonly OpenPositionView[]): string {
  const count = open.length
  const what = count === 1 ? '1 posición' : `${count} posiciones`
  const nets = open.map((p) => p.valuation.net)
  if (nets.some((net) => net === null)) return `Vas a cerrar ${what} al precio actual.`
  const total = nets.reduce<number>((sum, net) => sum + (net ?? 0), 0)
  return `Vas a cerrar ${what} por ${formatUsd(total, { sign: true })}.`
}

/** "La actual queda guardada y la podés volver a ver. Las 3 abiertas se cierran al precio actual." */
export function newSimulationText(count: number): string {
  const kept = 'La actual queda guardada y la podés volver a ver.'
  if (count === 0) return kept
  return `${kept} ${count === 1 ? 'La abierta se cierra' : `Las ${count} abiertas se cierran`} al precio actual.`
}

export function pauseText(count: number): string {
  return count === 0 ? 'Dejo de abrir posiciones nuevas.' : `Dejo de abrir posiciones nuevas y sigo cuidando ${theOpen(count)}.`
}

export function pausedToast(count: number): string {
  return count === 0 ? 'Bot pausado.' : `Bot pausado. Sigo cuidando ${theOpen(count)}.`
}

export function closeAllRowText(count: number): string {
  return count === 0 ? 'No hay posiciones abiertas.' : `Cierro ${theOpen(count)} al precio actual.`
}

export function closeAllSentToast(count: number): string {
  return `Enviado al bot: cierra ${theOpen(count)}.`
}
