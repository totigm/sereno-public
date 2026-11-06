import { sameMmrTable, type Settings } from '@sereno/shared'
import type { Unit } from './units'

// Los campos de Riesgo (avanzado), en el orden de la spec §11.1 Ajustes: tamaño, cortes
// de pérdida (§7, no aprendibles) y costos. La tabla de mmr va aparte porque es un mapa.

type Risk = Settings['risk']
export type RiskNumberKey = { [K in keyof Risk]: Risk[K] extends number ? K : never }[keyof Risk]

export interface RiskField {
  key: RiskNumberKey
  label: string
  unit: Unit
  description?: string
}

export interface RiskGroup {
  title: string
  fields: RiskField[]
  /** Los topes de tamaño no aplican en "Yo fijo tamaño y salidas" (spec §5.5). */
  autoOnly?: boolean
}

export const RISK_GROUPS: RiskGroup[] = [
  {
    title: 'Tamaño',
    autoOnly: true,
    fields: [
      { key: 'riskPerTrade', label: 'Riesgo por trade', unit: 'pct', description: 'Lo que pierde un stop tocado, sobre el capital base.' },
      { key: 'maxLeverage', label: 'Apalancamiento máximo', unit: 'leverage' },
      { key: 'maxPositions', label: 'Máximo de posiciones', unit: 'count' },
      { key: 'maxMarginPerTrade', label: 'Margen máximo por trade', unit: 'pct', description: 'Sobre el capital base.' },
      { key: 'maxMarginInUse', label: 'Margen máximo en uso', unit: 'pct', description: 'Entre todas las abiertas.' },
      { key: 'maxNotionalMultiple', label: 'Nocional máximo', unit: 'multiple', description: 'Entre todas las abiertas.' },
    ],
  },
  {
    title: 'Cortes de pérdida',
    fields: [
      { key: 'dailyLossLimit', label: 'Pérdida diaria máxima', unit: 'pct', description: 'Al llegar, no abro más hasta mañana.' },
      { key: 'maxDrawdown', label: 'Drawdown máximo', unit: 'pct', description: 'Desde el pico de equity; al llegar, me pauso.' },
      { key: 'maxConsecutiveStops', label: 'Stops seguidos', unit: 'count', description: 'Al llegar, dejo de entrar un rato.' },
      { key: 'streakPauseHours', label: 'Pausa después de la racha', unit: 'hours' },
      { key: 'maxSameDirection', label: 'Máximo en la misma dirección', unit: 'count' },
    ],
  },
  {
    title: 'Costos',
    fields: [
      { key: 'takerFeeRate', label: 'Comisión taker', unit: 'pct' },
      { key: 'makerFeeRate', label: 'Comisión maker', unit: 'pct' },
      { key: 'slippageRate', label: 'Slippage', unit: 'pct' },
    ],
  },
]

/** Mismos valores, sin importar el orden de las claves (jsonb las guarda ordenadas a su manera). */
export function sameRisk(a: Risk, b: Risk): boolean {
  const keys = Object.keys(a) as (keyof Risk)[]
  return keys.every((key) => (key === 'mmrBySymbol' ? sameMmrTable(a.mmrBySymbol, b.mmrBySymbol) : a[key] === b[key]))
}
