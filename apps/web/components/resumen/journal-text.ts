import { formatDateBA, formatUsd } from '@/lib/format'
import type { JournalEntry, JournalView } from '@/lib/queries/journal'

// Textos de "Lo último que hizo" (spec §11.1): el encabezado del tramo y la banda de
// liquidaciones. El tramo arranca a las 00:00 (Buenos Aires) del día anterior.

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function tradesText({ trades, won, pnl }: JournalView['summary']): string {
  if (trades === 0) return 'ninguna operación cerrada'
  const wins = won === 0 ? 'ninguna ganada' : plural(won, 'ganada', 'ganadas')
  return `${plural(trades, 'operación', 'operaciones')}, ${wins}, ${formatUsd(pnl, { sign: true })}`
}

function lookedText({ cycles, coins }: JournalView['summary']): string | null {
  if (cycles === 0 || coins === 0) return null
  return `Miré ${plural(coins, 'moneda', 'monedas')} ${plural(cycles, 'vez', 'veces')}.`
}

/**
 * "Desde ayer: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces." En un
 * replay o una archivada el tramo se nombra por su fecha: "Desde el 30 de octubre: …".
 */
export function journalSummary(journal: Pick<JournalView, 'summary' | 'from'>, { past }: { past: boolean }): string {
  const since = past ? `Desde el ${formatDateBA(journal.from)}` : 'Desde ayer'
  const looked = lookedText(journal.summary)
  return `${since}: ${tradesText(journal.summary)}.${looked === null ? '' : ` ${looked}`}`
}

/** "Hubo 1 liquidación desde ayer": la banda bajo el titular hasta que se toca. */
export function liquidationBandText(count: number): string {
  return `Hubo ${plural(count, 'liquidación', 'liquidaciones')} desde ayer.`
}

/** De dónde salen los números de una entrada de la sesión real; null si son los de siempre. */
export const REPORTED_SOURCE = 'datos de Binance'

/**
 * La frase y su origen por separado, para que la pantalla apague el origen. La frase
 * pierde el punto final: el origen la cierra ("… (+0,8R) · datos de Binance").
 */
export function journalParts(entry: Pick<JournalEntry, 'text' | 'reported'>): { text: string; source: string | null } {
  if (!entry.reported) return { text: entry.text, source: null }
  return { text: entry.text.replace(/\.$/, ''), source: REPORTED_SOURCE }
}

/** La entrada en una línea: "Cerré el long en BTC …: +US$ 1,20 (+0,8R) · datos de Binance". */
export function journalLine(entry: Pick<JournalEntry, 'text' | 'reported'>): string {
  const { text, source } = journalParts(entry)
  return source === null ? text : `${text} · ${source}`
}
