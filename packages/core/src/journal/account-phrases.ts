import { formatPct, formatTimeBA, formatUsd } from '@sereno/shared'
import type { EngineEvent } from '../types'
import { formatPctRound, formatUsdRound } from './format'

export type AccountRule = Extract<EngineEvent, { type: 'account_rule' }>['rule']

export interface ShieldPhraseInput {
  capitalInicial: number
  baseBlindaje: number
  // Lo que queda para operar después de blindar (saldo − baseBlindaje).
  ganancia: number
  // Posiciones cerradas para que el margen entre en lo ganado (`alBlindar: reducir`).
  closedCount: number
}

export interface AccountRuleData {
  daily_loss: { todayRealized: number; limitPct: number }
  drawdown: { peak: number; equity: number }
  streak: { stops: number; until: number }
  shield: ShieldPhraseInput
  shield_insufficient: { baseBlindaje: number }
  // `equity` es la de cuando tocó el piso, antes de cerrar.
  loss_floor: { capitalInicial: number; floor: number; equity: number; closedCount: number }
}

// Después de volver a usar el capital blindado la base es el saldo de ese momento
// y ya no es "inicial".
export function isInitialBase(baseBlindaje: number, capitalInicial: number): boolean {
  return Math.abs(baseBlindaje - capitalInicial) < 0.005
}

// "los US$ 1.000 iniciales" o, con la base movida, "US$ 1.312".
export function shieldedAmount(baseBlindaje: number, capitalInicial: number, format: (n: number) => string = formatUsdRound): string {
  const amount = format(baseBlindaje)
  return isInitialBase(baseBlindaje, capitalInicial) ? `los ${amount} iniciales` : amount
}

export function phraseShield(input: ShieldPhraseInput): string {
  const { closedCount } = input
  const main = `Blindé ${shieldedAmount(input.baseBlindaje, input.capitalInicial)}: de acá en más opero sólo con la ganancia (${formatUsdRound(input.ganancia)}).`
  if (closedCount === 0) return main
  const closed = closedCount === 1 ? 'Cerré 1 posición para que entre' : `Cerré ${closedCount} posiciones para que entren`
  return `${main} ${closed} en lo ganado.`
}

const RULE_PHRASES: { [R in AccountRule]: (data: AccountRuleData[R]) => string } = {
  daily_loss: ({ todayRealized, limitPct }) =>
    `Perdí ${formatUsd(Math.abs(todayRealized))} hoy y llegué al límite del ${formatPctRound(limitPct)} diario: no abro nada hasta mañana.`,
  drawdown: ({ peak, equity }) =>
    `Me pausé solo: el capital cayó${fallFromPeak(peak, equity)} desde el pico (de ${formatUsdRound(peak)} a ${formatUsdRound(equity)}). Lo reanudás vos cuando quieras.`,
  streak: ({ stops, until }) => `${stops} stops seguidos: no abro nada hasta las ${formatTimeBA(until)}.`,
  shield: phraseShield,
  shield_insufficient: ({ baseBlindaje }) =>
    `Me pausé solo: los ${formatUsdRound(baseBlindaje)} están blindados y no queda ganancia para operar.`,
  loss_floor: ({ floor, equity }) =>
    `Llegué al tope de pérdida: la cuenta quedó en ${formatUsd(equity)} y el piso era ${formatUsdRound(floor)}. Cerré todo y me apagué.`,
}

export function phraseAccountRule<R extends AccountRule>(rule: R, data: AccountRuleData[R]): string {
  return RULE_PHRASES[rule](data)
}

// La sombra no tiene quién la reanude: en su drawdown máximo vuelve a medir el pico y sigue.
export function phraseShadowDrawdown({ peak, equity }: AccountRuleData['drawdown']): string {
  return `La sombra cayó${fallFromPeak(peak, equity)} desde su pico (de ${formatUsdRound(peak)} a ${formatUsdRound(equity)}). No la pauso: sigue operando para que la comparación con lo aprendido no se corte.`
}

// " un 15,0%" para "cayó un 15,0% desde el pico". Sin pico positivo el porcentaje no
// tiene sentido (sería NaN o infinito) y la frase va sin él.
function fallFromPeak(peak: number, equity: number): string {
  return peak > 0 ? ` un ${formatPct((peak - equity) / peak, 1, false)}` : ''
}
