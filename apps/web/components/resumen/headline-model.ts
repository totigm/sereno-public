import { SHOWN_THRESHOLD } from '@sereno/core/src/journal/headline'
import type { HeadlineView } from '@/lib/derive'
import { formatUsd } from '@/lib/format'
import type { BotStatusView } from '@/lib/live/types'

// El titular de Resumen partido alrededor de su número (spec §11.1), para dibujar el
// monto destacado y que viaje solo cuando cambia poco. `key` cambia con el verbo: al
// cruzar cero la frase entera se reemplaza con un fundido cruzado (spec §11.3).

export type HeadlineTone = 'gain' | 'loss' | 'ink'

export interface HeadlineParts {
  key: string
  before: string
  /** El monto destacado, sin signo (el verbo dice para qué lado va); null si la frase no lleva número. */
  amount: number | null
  after: string
  tone: HeadlineTone
  /** El monto depende de precios viejos (sin conexión y con abiertas): va apagado. */
  stale: boolean
}

const EVEN = 0.01

function toneOf(n: number): HeadlineTone {
  if (Math.abs(n) < EVEN) return 'ink'
  return n > 0 ? 'gain' : 'loss'
}

function plain(key: string, text: string): HeadlineParts {
  return { key, before: text, amount: null, after: '', tone: 'ink', stale: false }
}

/** Parte la frase de core en el primer monto: es siempre el total (el segundo, si hay, viene después del "aunque"). */
function split(key: string, text: string, total: number, stale: boolean): HeadlineParts {
  const amountText = formatUsd(Math.abs(total))
  const at = text.indexOf(amountText)
  if (at < 0) return plain(key, text)
  return { key, before: text.slice(0, at), amount: Math.abs(total), after: text.slice(at + amountText.length), tone: toneOf(total), stale }
}

const verbKey = (total: number) => (Math.abs(total) < EVEN ? 'igual' : total > 0 ? 'ganando' : 'perdiendo')

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Sin operaciones todavía, el titular cuenta en qué anda el bot (spec §11.1, primer uso):
 * "Simulación lista." sin latido nunca (la banda del shell ya dice cómo arrancarlo),
 * "Calentando · 18 de 30 monedas." y "Mirando el mercado. Todavía no abrí ninguna operación."
 */
function beforeFirstTrade(bot: BotStatusView | null, offline: boolean): HeadlineParts {
  if (bot === null) return plain('lista', 'Simulación lista.')
  if (!offline && (bot.phase === 'warming' || bot.phase === 'starting') && bot.universeSize > 0) {
    return plain('calentando', `Calentando · ${bot.warmProgress} de ${plural(bot.universeSize, 'moneda', 'monedas')}.`)
  }
  if (!offline && bot.phase === 'live') return plain('mirando', 'Mirando el mercado. Todavía no abrí ninguna operación.')
  return plain('vacio', 'Todavía no abrí ninguna operación.')
}

/** El titular de la simulación activa, en presente, con la frase de core. */
export function presentHeadline(view: HeadlineView, bot: BotStatusView | null): HeadlineParts {
  if (!view.hasTrades) return beforeFirstTrade(bot, view.offline)
  return split(verbKey(view.total), view.text, view.total, view.valuedAt !== null)
}

export interface PastContext {
  /** Un replay es lo que hubiera pasado; una simulación archivada, lo que pasó. */
  replay: boolean
  days: number
}

function inDays(days: number): string {
  if (days < 1) return 'en menos de un día'
  const whole = Math.round(days)
  return `en ${plural(whole, 'día', 'días')}`
}

const VERBS = {
  replay: { won: 'Hubiera ganado', lost: 'Hubiera perdido', even: 'Hubiera terminado igual', none: 'No hubiera abierto ninguna operación' },
  archived: { won: 'Ganó', lost: 'Perdió', even: 'Terminó igual que empezó', none: 'No abrió ninguna operación' },
} as const

const opposes = (part: number, total: number) => Math.abs(part) >= SHOWN_THRESHOLD && Math.sign(part) !== Math.sign(total)
const went = (n: number) => (n > 0 ? 'ganando' : 'perdiendo')

/**
 * El titular de un replay o de una simulación archivada, en pasado (spec §11.1, contexto de
 * sesión): "Hubiera ganado US$ 412,30 en 90 días." Si una parte terminó para el otro lado,
 * la nombra después, como el titular en presente ("…en 90 días, aunque las abiertas…").
 */
export function pastHeadline(view: HeadlineView, { replay, days }: PastContext): HeadlineParts {
  const verbs = replay ? VERBS.replay : VERBS.archived
  const when = inDays(days)
  if (!view.hasTrades) return plain('vacio', `${verbs.none} ${when}.`)
  const { total, realized, unrealized } = view
  if (Math.abs(total) < EVEN) return plain('igual', `${verbs.even}, ${when}.`)

  const main = `${total > 0 ? verbs.won : verbs.lost} ${formatUsd(Math.abs(total))} ${when}`
  const text = opposes(unrealized, total)
    ? `${main}, aunque las abiertas al final iban ${went(unrealized)} ${formatUsd(Math.abs(unrealized))}.`
    : opposes(realized, total)
      ? `${main}, aunque lo cerrado iba ${went(realized)} ${formatUsd(Math.abs(realized))}.`
      : `${main}.`
  return split(verbKey(total), text, total, false)
}
