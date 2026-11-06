import clsx from 'clsx'
import { useId } from 'react'
import type { ReplayFortnight } from '@sereno/db'
import { plural } from '@/components/aprendizaje/labels'
import { ResultText } from '@/components/posiciones/result-text'
import { fortnightLabel } from './report-text'

// En el celu, "2 ago → 16 ago" con "12 operaciones · 7 ganadas" abajo y el resultado a la
// derecha; en desktop, una tabla con la unidad en el encabezado (spec §11.2).
const COLUMNS = 'desktop:grid desktop:grid-cols-[1.5fr_0.9fr_0.9fr_1fr] desktop:items-center desktop:gap-x-5'

/** Trades por quincena del replay (spec §9): cuántos, cuántos ganados y el resultado neto. */
export function ReportFortnights({ fortnights, now }: { fortnights: readonly ReplayFortnight[]; now: number }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-sm font-semibold">
        Por quincena
      </h3>
      <div role="table" aria-label="Operaciones por quincena" className="panel px-4">
        <div role="rowgroup" className="hidden desktop:block">
          <div role="row" className={clsx(COLUMNS, 'h-10 text-sm text-muted')}>
            <span role="columnheader">Quincena</span>
            <span role="columnheader" className="text-right">
              Operaciones
            </span>
            <span role="columnheader" className="text-right">
              Ganadas
            </span>
            <span role="columnheader" className="text-right">
              Resultado en US$
            </span>
          </div>
        </div>
        <div role="rowgroup" className="divide-y divide-line desktop:border-t desktop:border-line">
          {fortnights.map((f) => (
            <div key={f.from} role="row" className={clsx(COLUMNS, 'flex min-h-12 items-center justify-between gap-3 py-2 tabular-nums')}>
              <span role="cell" className="min-w-0">
                <span className="block">{fortnightLabel(f, now)}</span>
                <span className="block text-sm text-muted desktop:hidden">{`${plural(f.trades, 'operación', 'operaciones')} · ${plural(f.wins, 'ganada', 'ganadas')}`}</span>
              </span>
              <span role="cell" className="hidden text-right desktop:block">
                {f.trades}
              </span>
              <span role="cell" className="hidden text-right desktop:block">
                {f.wins}
              </span>
              <span role="cell" className="text-right">
                {f.trades === 0 ? <span className="text-muted">sin operaciones</span> : <ResultText value={f.pnlNet} dense />}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
