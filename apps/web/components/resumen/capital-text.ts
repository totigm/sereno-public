import { isInitialBase, shieldedAmount } from '@sereno/core/src/journal/account-phrases'
import { formatPctRound, formatUsdWhole } from '@sereno/core/src/journal/format'
import type { CapitalCard, CapitalCardInput } from '@sereno/core/src/journal/phrases'
import { formatDateBA } from '@/lib/format'

// "Tu capital" en pasado, para un replay o una simulación archivada (spec §11.1, contexto
// de sesión). Mismos tres estados, mismo disparador y mismas palabras que la tarjeta en
// presente de core (`capitalCard`), contados como algo que terminó.

/** Lo mismo que la tarjeta de core; en pasado algunos estados no tienen segunda línea. */
export type CapitalCardView = Omit<CapitalCard, 'detail'> & { detail: string | null }

const AT_RISK_MIN = 0.005

function shieldedPast({ account, shieldedAt, pausedByShield }: CapitalCardInput): CapitalCardView {
  const { protegido, capitalBase } = account
  const reinvest = account.reinvest ? `sí · cada operación se calculaba sobre ${formatUsdWhole(capitalBase)}` : 'no aplicaba con el capital blindado'
  const excess = account.margenEnUso - (account.saldo - protegido)
  const atRisk = excess >= AT_RISK_MIN ? `capital blindado en riesgo al final: ${formatUsdWhole(excess)}` : null
  if (pausedByShield) {
    return {
      title: `Terminó pausado: los ${formatUsdWhole(protegido)} estaban blindados y no quedaba ganancia para operar.`,
      detail: null,
      progress: 1,
      reinvest,
      atRisk,
    }
  }
  const when = shieldedAt === null ? '' : ` el ${formatDateBA(shieldedAt)}`
  return {
    title: `Blindó ${shieldedAmount(protegido, account.capitalInicial, formatUsdWhole)}${when}.`,
    detail: `Al final operaba con ${formatUsdWhole(capitalBase)}.`,
    progress: 1,
    reinvest,
    atRisk,
  }
}

export function pastCapitalCard(input: CapitalCardInput): CapitalCardView {
  const { account, protectPct } = input
  if (account.protegido > 0) return shieldedPast(input)
  const reinvest = account.reinvest
    ? `sí · cada operación se calculaba sobre ${formatUsdWhole(account.capitalBase)}`
    : `no · siempre sobre ${formatUsdWhole(account.capitalBase)}`
  if (protectPct <= 0) {
    return { title: `Sin blindaje: operó con todo el capital (${formatUsdWhole(account.capitalBase)}).`, detail: null, progress: null, reinvest, atRisk: null }
  }
  const { baseBlindaje, capitalInicial } = account
  const target = protectPct * baseBlindaje
  const gain = Math.min(account.saldo, account.equity) - baseBlindaje
  return {
    title: `Quedó a ${formatUsdWhole(Math.max(0, target - gain), 'ceil')} de blindar ${shieldedAmount(baseBlindaje, capitalInicial, formatUsdWhole)}.`,
    detail: `Blindaba cuando la ganancia${isInitialBase(baseBlindaje, capitalInicial) ? '' : ' nueva'} llegara a ${formatUsdWhole(target, 'ceil')} (${formatPctRound(protectPct)}).`,
    progress: target > 0 ? Math.min(1, Math.max(0, gain / target)) : 0,
    reinvest,
    atRisk: null,
  }
}
