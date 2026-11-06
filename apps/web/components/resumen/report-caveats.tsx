import { useId } from 'react'
import { glue } from '@/components/ajustes/glue'
import type { ResumenReportView } from '@/lib/queries/resumen-report'
import { reportCaveats } from './report-text'

/**
 * "Para tener en cuenta": lo que un replay no pudo reproducir y cambia cómo se lee el
 * resultado (spec §9). El sesgo de supervivencia va siempre, con o sin reporte del bot.
 */
export function ReportCaveats({ report, now }: { report: ResumenReportView | null; now: number }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-sm font-semibold">
        Para tener en cuenta
      </h3>
      <ul className="panel flex flex-col px-4 text-[0.9375rem] text-pretty">
        {reportCaveats(report, now).map((line) => (
          <li key={line} className="border-t border-line py-2.5 first:border-t-0">
            {glue(line)}
          </li>
        ))}
      </ul>
    </section>
  )
}
