import { isInitialBase, shieldedAmount } from '@sereno/core/src/journal/account-phrases'
import { formatPctRound, formatUsdRound } from '@sereno/core/src/journal/format'
import { glue } from './glue'

export interface ShieldBasis {
  capitalInicial: number
  /** Desde dónde mide el blindaje: I₀ al crear, el saldo después de volver a usar el capital. */
  baseBlindaje: number
}

/**
 * La vista previa del blindaje (spec §11.1 Ajustes): "Cuando la ganancia llegue a 70%
 * (US$ 700), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado." Mismo
 * disparador y mismas palabras que la tarjeta "Tu capital" de Resumen.
 */
export function shieldPreview(protectPct: number, { capitalInicial, baseBlindaje }: ShieldBasis): string {
  if (protectPct <= 0) return 'Sin blindaje: el bot opera con todo el capital, también con el inicial.'
  const gain = isInitialBase(baseBlindaje, capitalInicial) ? 'la ganancia' : 'la ganancia nueva'
  const target = formatUsdRound(protectPct * baseBlindaje)
  return `Cuando ${gain} llegue a ${formatPctRound(protectPct)} (${target}), blindo ${shieldedAmount(baseBlindaje, capitalInicial)} y sigo sólo con lo ganado.`
}

/** En pasado, para un replay o una simulación archivada. */
export function shieldPast(protectPct: number, { capitalInicial, baseBlindaje }: ShieldBasis): string {
  if (protectPct <= 0) return 'Sin blindaje: operaba con todo el capital.'
  const amount = shieldedAmount(baseBlindaje, capitalInicial)
  return `Blindaba ${amount} al llegar a ${formatUsdRound(protectPct * baseBlindaje)} de ganancia.`
}

/**
 * La frase viva debajo del campo: cambia mientras se escribe, antes de guardar. Es una
 * región `polite`: quien usa lector de pantalla la escucha al terminar de escribir.
 */
export function LivePreview({ text }: { text: string }) {
  return (
    <p aria-live="polite" className="rounded-control bg-bg px-3.5 py-3 text-[0.9375rem] text-pretty">
      {glue(text)}
    </p>
  )
}
