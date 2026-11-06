// El dashboard formatea con las mismas funciones que el bot: un único punto de
// importación para que las pantallas no dependan del nombre del paquete.
import { formatPct } from '@sereno/shared'

export * from '@sereno/shared'

export type ShownTone = 'gain' | 'loss' | 'muted'

/**
 * El tono de un porcentaje según lo que se lee, no el valor crudo: un +0,03 % se muestra
 * "0,0%" y no va en verde. Redondea con el mismo `formatPct` del texto.
 */
export function toneOfShown(value: number, decimals = 1): ShownTone {
  if (!Number.isFinite(value) || !/[1-9]/.test(formatPct(value, decimals, false))) return 'muted'
  return value > 0 ? 'gain' : 'loss'
}

const conjunction = new Intl.ListFormat('es', { type: 'conjunction' })

/** "a, b y c": lo que falta, en una frase. */
export function formatList(items: readonly string[]): string {
  return conjunction.format(items)
}
