import { formatDateBA } from '@sereno/shared'
import type { AccountSnapshot } from '../types'
import { isInitialBase, shieldedAmount } from './account-phrases'
import { formatPctRound, formatUsdWhole } from './format'

export interface CapitalCardInput {
  account: AccountSnapshot
  protectPct: number
  // Cuándo se disparó el blindaje vigente, si se sabe.
  shieldedAt: number | null
  // El bot se pausó solo porque el capital operable no alcanza ("capital blindado y sin ganancia").
  pausedByShield: boolean
}

export interface CapitalCard {
  title: string
  detail: string
  // Avance hacia el blindaje (0…1); null con el blindaje apagado.
  progress: number | null
  // Línea de reinversión, igual en los tres estados de la tarjeta.
  reinvest: string
  // "capital blindado en riesgo: US$ X" cuando el margen de las abiertas supera el colchón.
  atRisk: string | null
}

// Tarjeta "Tu capital" de Resumen (spec §7 y §11.1): antes del blindaje, blindado,
// blindado y pausado solo; más el caso del blindaje apagado.
export function capitalCard(input: CapitalCardInput): CapitalCard {
  const { account } = input
  if (account.protegido > 0) return shieldedCard(input)

  const reinvest = account.reinvest
    ? `sí · cada operación se calcula sobre ${formatUsdWhole(account.capitalBase)}`
    : `no · siempre sobre ${formatUsdWhole(account.capitalBase)}`

  if (input.protectPct <= 0) {
    return {
      title: `Sin blindaje: el bot opera con todo el capital (${formatUsdWhole(account.capitalBase)}).`,
      detail: 'Activá el blindaje en Ajustes para guardar el capital inicial.',
      progress: null,
      reinvest,
      atRisk: null,
    }
  }

  // Mismo disparador que `Account.checkShield`: la ganancia desde que se fijó la base,
  // la menor entre la realizada y la de equity (spec §7).
  const { baseBlindaje, capitalInicial } = account
  const target = input.protectPct * baseBlindaje
  const gain = Math.min(account.saldo, account.equity) - baseBlindaje
  return {
    title: `A ${formatUsdWhole(Math.max(0, target - gain), 'ceil')} de blindar ${shieldedAmount(baseBlindaje, capitalInicial, formatUsdWhole)}`,
    detail: `Cuando la ganancia${isInitialBase(baseBlindaje, capitalInicial) ? '' : ' nueva'} llegue a ${formatUsdWhole(target, 'ceil')} (${formatPctRound(input.protectPct)}), el bot sigue sólo con lo ganado.`,
    // Sin base (saldo cero al volver a usar el capital) no hay nada que blindar.
    progress: target > 0 ? Math.min(1, Math.max(0, gain / target)) : 0,
    reinvest,
    atRisk: null,
  }
}

function shieldedCard({ account, shieldedAt, pausedByShield }: CapitalCardInput): CapitalCard {
  const { protegido, capitalBase } = account
  const reinvest = account.reinvest
    ? `sí · cada operación se calcula sobre ${formatUsdWhole(capitalBase)}`
    : 'no aplica mientras el capital esté blindado'
  // El colchón es lo que no está blindado; si el margen de las abiertas lo supera,
  // la diferencia sale del capital blindado.
  const excess = account.margenEnUso - (account.saldo - protegido)
  const atRisk = excess >= 0.005 ? `capital blindado en riesgo: ${formatUsdWhole(excess)}` : null

  if (pausedByShield) {
    return {
      title: `El bot se pausó: los ${formatUsdWhole(protegido)} están blindados y no queda ganancia para operar.`,
      detail: 'Podés volver a usar el capital blindado para que siga operando.',
      progress: 1,
      reinvest,
      atRisk,
    }
  }
  const when = shieldedAt === null ? '' : ` el ${formatDateBA(shieldedAt)}`
  return {
    title: `Blindaste ${shieldedAmount(protegido, account.capitalInicial, formatUsdWhole)}${when}.`,
    detail: `El bot opera con ${formatUsdWhole(capitalBase)}.`,
    progress: 1,
    reinvest,
    atRisk,
  }
}
