'use client'

import { useId, useState } from 'react'
import { plural } from '@/components/aprendizaje/labels'
import { EM_DASH, formatSigned } from '@/lib/format'
import type { SignalPairView } from '@/lib/queries/resumen-report'
import { pairLabel } from './report-text'

/** Los más parecidos a la vista; el resto, al pedirlo. */
const TOP = 5

/**
 * La correlación entre señales del replay (spec §9) como una lista de pares ordenada por
 * |ρ|: en el celu, una matriz de 10 × 10 no se lee. Dos señales muy correlacionadas
 * cuentan dos veces lo mismo en S′.
 */
export function SignalPairs({ pairs }: { pairs: readonly SignalPairView[] }) {
  const [all, setAll] = useState(false)
  const titleId = useId()
  const listId = useId()
  const shown = all ? pairs : pairs.slice(0, TOP)

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-[0.9375rem] font-semibold">
        Correlación entre señales
      </h3>
      <p className="text-sm text-pretty text-muted">
        Qué tan parecido dieron dos señales en las mismas decisiones, de −1 (opuestas) a +1 (iguales). Dos muy parecidas cuentan dos veces lo
        mismo.
      </p>
      {pairs.length === 0 ? (
        <p className="panel p-4 text-muted">No hubo decisiones con dos señales para comparar.</p>
      ) : (
        <ul id={listId} aria-labelledby={titleId} className="panel flex flex-col px-4">
          {shown.map((p) => (
            <li key={`${p.a}-${p.b}`} className="flex items-baseline justify-between gap-4 border-t border-line py-2.5 first:border-t-0">
              <span className="min-w-0">
                <span className="block text-[0.9375rem] text-pretty">{pairLabel(p.a, p.b)}</span>
                <span className="block text-sm text-muted tabular-nums">
                  {p.rho === null ? 'sin datos suficientes' : `en ${plural(p.decisions, 'decisión', 'decisiones')}`}
                </span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{p.rho === null ? EM_DASH : formatSigned(p.rho, 2)}</span>
            </li>
          ))}
        </ul>
      )}
      {pairs.length > TOP && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((v) => !v)}
          className="pressable -my-1.5 inline-flex min-h-11 items-center self-start rounded-control text-sm font-medium text-muted hover:text-ink"
        >
          {all ? 'Ver sólo los más parecidos' : `Ver los ${pairs.length} pares`}
        </button>
      )}
    </section>
  )
}
