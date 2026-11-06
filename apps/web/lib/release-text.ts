import { formatPctRound, formatUsdRound } from '@sereno/core/src/journal/format'

/**
 * Lo que pasa al volver a usar el capital blindado (spec §7): la base pasa a ser el saldo
 * de ahora. Lo dicen igual la confirmación de "Tu capital" en Resumen y Ajustes › Capital.
 */
export function releaseText(protegido: number, saldo: number, protectPct: number): string {
  const back = `Los ${formatUsdRound(protegido)} blindados vuelven a operar.`
  if (protectPct <= 0) return `${back} El blindaje está apagado, así que no se vuelve a disparar.`
  return `${back} El blindaje vuelve a medir desde ${formatUsdRound(saldo)}: se dispara cuando ganes otros ${formatUsdRound(protectPct * saldo)} (${formatPctRound(protectPct)}).`
}
