import clsx from 'clsx'
import { formatPct } from '@/lib/format'
import { resultParts } from './format'

export interface ResultTextProps {
  /** Neto en US$; null si no hay precio para valuarla. */
  value: number | null
  /** Fracción del margen; va entre paréntesis. */
  pct?: number | null
  /** Precio viejo (sin conexión): el número va apagado. */
  stale?: boolean
  /**
   * Lista densa con la unidad en el encabezado (spec §11.2): en desktop se ve sólo el número;
   * "US$" queda para lectores de pantalla y a la vista en el celu, donde no hay encabezado.
   */
  dense?: boolean
  className?: string
}

/** "+US$ 12,40 (+4,1%)": el signo va siempre, así ganancia y pérdida no dependen sólo del color. */
export function ResultText({ value, pct = null, stale = false, dense = false, className }: ResultTextProps) {
  if (value === null) return <span className={clsx('text-muted', className)}>sin precio</span>
  const tone = stale ? 'text-muted' : value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : 'text-ink'
  // Las partes de `formatResult` ("+US$ 12,40"), con la unidad aparte para poder esconderla.
  const { sign, magnitude } = resultParts(value)
  return (
    <span className={clsx('whitespace-nowrap', tone, className)}>
      <span className="font-semibold">
        {sign}
        <span className={clsx(dense && 'desktop:sr-only')}>US$ </span>
        {magnitude}
      </span>
      {pct !== null && <span className="font-normal"> ({formatPct(pct)})</span>}
    </span>
  )
}
