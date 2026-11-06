import { formatUsdRound } from '@sereno/core/src/journal/format'
import type { RealSessionView } from '@/lib/queries/real'
import { LOSS_FLOOR_TEXT, offMissingText } from '@/lib/real-copy'

// Cómo está la sesión con plata real, en una frase: lo que dice la base (prendida,
// apagada, en el tope) y lo que el bot informó que le falta ("apagada: falta X").

export function realStateText(session: Pick<RealSessionView, 'status' | 'capital' | 'gate'>): string {
  const { status, gate } = session
  if (status === 'loss_floor') return LOSS_FLOOR_TEXT
  if (gate && gate.mode !== 'trading' && gate.missing.length > 0) {
    const missing = `${offMissingText(gate.missing)}.`
    return status === 'on' ? `${missing} Mientras tanto no abre nada y sigue cuidando las abiertas.` : missing
  }
  if (status === 'off') return 'Apagada: no abre nada. Lo que quedó abierto sigue con sus stops en Binance.'
  if (gate === null) return 'Prendida. El bot todavía no la tomó: en la Mac, pnpm bot.'
  return `Prendida: opera con ${formatUsdRound(session.capital)} de tu cuenta de futuros.`
}
