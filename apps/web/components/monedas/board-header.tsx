import { formatTimeBA } from '@/lib/format'
import { boardHeadline, type BoardMode } from './phrases'

export interface BoardHeaderProps {
  count: number
  open: number
  mode: BoardMode
  /** Hora de los precios: se aclara sin conexión. */
  marksAt: number | null
}

/** La leyenda de la barra: de short a la izquierda a long a la derecha. */
function LeanLegend() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="sr-only">La barra de cada moneda va de short, a la izquierda, a long, a la derecha.</span>
      <span aria-hidden>short</span>
      <span aria-hidden className="relative block h-1 w-12 rounded-chip bg-line">
        <span className="absolute inset-y-0 left-0 w-1/2 rounded-l-chip bg-loss opacity-45" />
        <span className="absolute inset-y-0 right-0 w-1/2 rounded-r-chip bg-gain opacity-45" />
        <span className="absolute -top-0.5 left-1/2 h-2 w-px -translate-x-1/2 bg-muted/70" />
      </span>
      <span aria-hidden>long</span>
    </span>
  )
}

/** El titular del tablero y cómo leerlo: el orden de las baldosas y qué es la barra. */
export function BoardHeader({ count, open, mode, marksAt }: BoardHeaderProps) {
  const past = mode === 'replay' || mode === 'archived'
  return (
    <header className="flex flex-col gap-2">
      <h1 className="headline">{boardHeadline(count, open, mode)}</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <p>{past ? 'Primero las abiertas al final, después las que más se inclinaban.' : 'Primero las abiertas, después las que más se inclinan.'}</p>
        <LeanLegend />
        {mode === 'offline' && marksAt !== null && <p>Precios de las {formatTimeBA(marksAt)}.</p>}
      </div>
    </header>
  )
}
