'use client'

import { formatPrice } from '@sereno/core/src/journal/format'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimeBA } from '@/lib/format'
import type { CoinDetail } from '@/lib/queries/monedas'
import { PriceLine, type LineTone } from './price-line'

export interface CoinChartProps {
  symbol: string
  name: string
  /** Las velas que trajo el servidor para `?moneda=`; de otra moneda mientras llegan las nuevas. */
  detail: CoinDetail | null
  past: boolean
  stale: boolean
  marksAt: number | null
}

/** El gráfico de la hoja: espera las velas de esta moneda con la misma geometría (spec §11.4). */
export function CoinChart({ symbol, name, detail, past, stale, marksAt }: CoinChartProps) {
  if (detail?.symbol !== symbol) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Cargando el gráfico…</span>
        {/* El alto del gráfico más la línea del tramo de tiempo. */}
        <Skeleton className="h-[242px] w-full rounded-panel" />
      </div>
    )
  }
  const { candles } = detail
  const first = candles[0]?.close
  const last = candles.at(-1)?.close
  if (first === undefined || last === undefined || candles.length < 2) {
    return <p className="text-sm text-muted">Sin velas de las últimas 48 h.</p>
  }

  const closes = candles.map((c) => c.close)
  const tone: LineTone = stale ? 'muted' : last >= first ? 'gain' : 'loss'
  const end = past ? 'al final' : stale && marksAt !== null ? `a las ${formatTimeBA(marksAt)}` : 'ahora'
  const label =
    `Precio de ${name} en las 48 h ${past ? 'anteriores al final' : 'últimas'}: ` +
    `entre ${formatPrice(Math.min(...closes))} y ${formatPrice(Math.max(...closes))}, ${end} ${formatPrice(last)}.`

  return <PriceLine candles={candles} tone={tone} label={label} from={past ? '48 h antes' : 'hace 48 h'} to={end} />
}
