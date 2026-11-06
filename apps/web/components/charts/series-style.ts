// Trazo de las líneas opcionales de la curva de equity, el mismo en el gráfico y en la
// muestra de su botón: así la leyenda distingue Saldo de Originales por la forma y no
// sólo por un gris contra otro. Saldo va sólido y fino; Originales, discontinuo (el
// punteado `0 6` queda para los huecos de la curva).

export type OptionalSeries = 'saldo' | 'shadow'

export interface SeriesStroke {
  stroke: string
  strokeOpacity?: number
  strokeWidth: number
  strokeDasharray?: string
  strokeLinecap: 'round' | 'butt'
}

export const SERIES_STROKE: Record<OptionalSeries, SeriesStroke> = {
  saldo: { stroke: 'var(--ink)', strokeOpacity: 0.55, strokeWidth: 1.25, strokeLinecap: 'round' },
  shadow: { stroke: 'var(--muted)', strokeWidth: 2, strokeDasharray: '5 4', strokeLinecap: 'butt' },
}
