import { formatUsd } from '@sereno/shared'

export interface HeadlineInput {
  // equity − capitalInicial: lo que quedaría si se cerrara todo ahora (spec §11.1).
  total: number
  realized: number
  unrealized: number
  // "el 14 de octubre", "ayer", "hoy a las 10:15" (`sinceLabel` de `@sereno/shared`).
  sinceLabel: string
  hasTrades: boolean
  // Bot sin conexión: hora ("14:32") del último snapshot con el que se valuaron las abiertas.
  offline?: { at: string }
}

// Por debajo de un centavo el titular dice "igual".
const EVEN_THRESHOLD = 0.01
// Un componente que se mostraría como "US$ 0,00" no da para un "aunque". Exportado:
// el dashboard marca los signos distintos con el mismo umbral que esta frase.
export const SHOWN_THRESHOLD = 0.005

const going = (n: number): string => (n > 0 ? 'ganando' : 'perdiendo')
const opposes = (part: number, total: number): boolean => Math.abs(part) >= SHOWN_THRESHOLD && Math.sign(part) !== Math.sign(total)

export function headline(input: HeadlineInput): string {
  const { total, realized, unrealized, sinceLabel, hasTrades, offline } = input
  if (!hasTrades) return 'Todavía no abrí ninguna operación.'

  const valuedAt = offline ? `, con las abiertas valuadas a las ${offline.at}` : ''
  if (Math.abs(total) < EVEN_THRESHOLD) return `Estás igual que ${sinceLabel}${valuedAt}.`

  const main = `Vas ${going(total)} ${formatUsd(Math.abs(total))}`
  // Si una parte va para el otro lado, la frase la nombra en lugar del "desde".
  if (opposes(unrealized, total)) {
    const at = offline ? ` (valuadas a las ${offline.at})` : ''
    return `${main}, aunque las abiertas van ${going(unrealized)} ${formatUsd(Math.abs(unrealized))}${at}.`
  }
  if (opposes(realized, total)) {
    return `${main}, aunque lo cerrado va ${going(realized)} ${formatUsd(Math.abs(realized))}${valuedAt}.`
  }
  return `${main} desde ${sinceLabel}${valuedAt}.`
}
