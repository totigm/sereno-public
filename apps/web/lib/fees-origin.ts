import { formatDateBA, sameAccountTiers, type AccountTiersFields, type Settings } from '@sereno/shared'

// De dónde salen el mmr y las comisiones de Riesgo (avanzado): de la cuenta de Binance
// (la última versión que guardó el bot con la clave de sólo lectura), editados a mano
// después de eso, o los supuestos del documento.

/** El mmr y las comisiones de la última versión que guardó el bot con los datos de la cuenta. */
export interface AccountTiersView extends AccountTiersFields {
  at: number
}

export type FeesOrigin = { source: 'binance'; at: number } | { source: 'edited'; at: number } | { source: 'assumptions' }

export function feesOrigin(risk: Settings['risk'], tiers: AccountTiersView | null): FeesOrigin {
  if (!tiers) return { source: 'assumptions' }
  return { source: sameAccountTiers(risk, tiers) ? 'binance' : 'edited', at: tiers.at }
}

export function feesOriginText(origin: FeesOrigin): string {
  switch (origin.source) {
    case 'binance':
      return `Comisiones y mmr: de tu cuenta de Binance · actualizado el ${formatDateBA(origin.at)}.`
    case 'edited':
      // El trabajo diario del bot vuelve a poner los de la cuenta si difieren.
      return `Comisiones y mmr: los cambiaste a mano. Los de tu cuenta de Binance (del ${formatDateBA(origin.at)}) vuelven con la actualización diaria.`
    case 'assumptions':
      return 'Comisiones y mmr: supuestos (sin clave de Binance).'
  }
}
