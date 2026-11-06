'use client'

import { Sheet } from '@/components/ui/sheet'
import type { ResumenReportView } from '@/lib/queries/resumen-report'
import { MissingSignals } from './missing-signals'
import { hasHiddenRanges } from './report-text'
import { SignalPairs } from './signal-pairs'
import { SprimeHistogram } from './sprime-histogram'
import { UniverseDays } from './universe-days'

export interface ReportSheetProps {
  open: boolean
  onClose: () => void
  report: ResumenReportView
  now: number
}

/**
 * Lo más pesado del reporte de un replay (spec §9), en una hoja: el histograma de S′, la
 * correlación entre señales, el universo por día y, si en línea no entraban, todos los
 * tramos de las señales que faltaron.
 */
export function ReportSheet({ open, onClose, report, now }: ReportSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Señales y universo">
      <div className="flex flex-col gap-9 pb-2">
        <SprimeHistogram bins={report.histogram} theta={report.theta} />
        <SignalPairs pairs={report.pairs} />
        <UniverseDays universe={report.universe} now={now} />
        {hasHiddenRanges(report.missingSignals) && <MissingSignals missing={report.missingSignals} now={now} full />}
      </div>
    </Sheet>
  )
}
