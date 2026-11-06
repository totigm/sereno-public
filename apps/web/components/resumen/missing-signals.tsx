import { useId } from 'react'
import { signalLabel } from '@/components/aprendizaje/labels'
import type { MissingSignalView } from '@/lib/queries/resumen-report'
import { missingSignalText } from './report-text'

export interface MissingSignalsProps {
  missing: readonly MissingSignalView[]
  now: number
  /** Todos los tramos de cada señal (en la hoja); sin él, hasta dos y el resumen. */
  full?: boolean
}

/** "La lista de señales no disponibles con sus fechas" (spec §9): por señal, los días y en cuántas monedas. */
export function MissingSignals({ missing, now, full = false }: MissingSignalsProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-sm font-semibold">
        Señales que faltaron
      </h3>
      <ul aria-labelledby={titleId} className="panel flex flex-col px-4 text-[0.9375rem] text-pretty">
        {missing.map((m) => (
          <li key={m.signal} className="border-t border-line py-2.5 first:border-t-0">
            <span className="font-medium">{signalLabel(m.signal)}</span>
            {`: ${missingSignalText(m, now, { full })}`}
          </li>
        ))}
      </ul>
    </section>
  )
}
