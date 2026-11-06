import { deriveAccount, deriveCapitalCard, isPausedByShield, marksOf } from '@/lib/derive'
import type { LivePayload } from '@/lib/live/types'
import { releaseText } from '@/lib/release-text'
import type { ReleaseAction } from './capital-card'
import { pastCapitalCard, type CapitalCardView } from './capital-text'

export interface CapitalView {
  view: CapitalCardView
  /** Sólo en el estado 3 de la simulación activa. */
  release: ReleaseAction | null
}

/**
 * "Tu capital" con la cuenta valuada a las marcas que llegan en vivo: la tarjeta de core
 * en la activa, en pasado en un replay o una archivada. Null sin ajustes (no hay con qué
 * calcular el blindaje).
 */
export function capitalView(live: LivePayload, { past, shieldedAt }: { past: boolean; shieldedAt: number | null }): CapitalView | null {
  const { settings } = live
  if (!settings) return null
  const pausedByShield = isPausedByShield(live)
  if (past) {
    const account = deriveAccount(live.ledger, settings.capital, live.open, marksOf(live.market))
    return { view: pastCapitalCard({ account, protectPct: settings.capital.protectPct, shieldedAt, pausedByShield }), release: null }
  }
  const view = deriveCapitalCard(live, shieldedAt)
  if (!view) return null
  const release: ReleaseAction | null = pausedByShield
    ? {
        sessionId: live.sessionId,
        offline: live.offline,
        commands: live.commands,
        description: releaseText(live.ledger.protegido, live.ledger.saldo, settings.capital.protectPct),
      }
    : null
  return { view, release }
}
