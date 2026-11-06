import { useId } from 'react'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { UniverseView } from '@/lib/queries/resumen-report'
import { universeChangeText, universeSummary, utcDayLabel } from './report-text'

/**
 * El universo por día del replay (spec §9): cuántas monedas, las del primer día y, día por
 * día, sólo lo que cambió (con 30 monedas y 90 días, la lista entera no se lee).
 */
export function UniverseDays({ universe, now }: { universe: UniverseView; now: number }) {
  const titleId = useId()
  const { first, changes } = universe

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-[0.9375rem] font-semibold">
        Universo por día
      </h3>
      {universe.days === 0 ? (
        <p className="text-muted">El bot no dejó el universo de cada día.</p>
      ) : (
        <>
          <p className="text-[0.9375rem] text-pretty">{universeSummary(universe)}</p>
          {first && first.symbols.length > 0 && (
            <p className="text-sm text-pretty text-muted">{`El primer día (${utcDayLabel(first.day, now)}): ${first.symbols.map(coinName).join(', ')}.`}</p>
          )}
          {changes.length > 0 && (
            <ul aria-label="Cambios del universo" className="panel flex flex-col px-4">
              {changes.map((change) => (
                <li key={change.day} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 border-t border-line py-2.5 text-[0.9375rem] first:border-t-0">
                  <span className="text-muted tabular-nums">{utcDayLabel(change.day, now)}</span>
                  <span className="min-w-0 text-pretty">{universeChangeText(change)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
