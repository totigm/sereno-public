'use client'

import Link from 'next/link'
import { coinName } from '@sereno/core/src/journal/coin-name'
import { replayParamsLabel } from '@/components/aprendizaje/labels'
import { useUrlSheet } from '@/components/aprendizaje/use-url-sheet'
import { glue } from '@/components/ajustes/glue'
import { formatResult } from '@/components/posiciones/format'
import { Button } from '@/components/ui/button'
import { formatNumber, formatPct, formatSigned, formatUsd } from '@/lib/format'
import type { ResumenReportView } from '@/lib/queries/resumen-report'
import type { SessionView } from '@/lib/queries/session'
import type { StatsView } from '@/lib/queries/stats'
import { useHydrated } from '@/lib/use-hydrated'
import { MissingSignals } from './missing-signals'
import { ReportCaveats } from './report-caveats'
import { ReportFortnights } from './report-fortnights'
import { ReportSheet } from './report-sheet'
import { Section } from './section'

export interface SessionReportProps {
  session: SessionView
  stats: StatsView
  /** Lo realizado: la suma de `pnlNet` de las cerradas (lo pagado por las abiertas va del lado de lo abierto). */
  realized: number
  /** Lo que el bot dejó al terminar el replay; null en una simulación archivada o si no lo dejó. */
  report: ResumenReportView | null
  /** Reloj de las fechas (el año aparece sólo si no es el de ahora). */
  now: number
  /** Posiciones › Estadísticas de esta sesión: por moneda y el veredicto completo. */
  statsHref: string
  className?: string | undefined
}

/** La hoja con el histograma, la correlación y el universo, reflejada en la URL (`?reporte=detalle`). */
const SHEET_PARAM = 'reporte'

interface Row {
  label: string
  value: string
}

function coinExtremes(bySymbol: StatsView['bySymbol']): { best: Row | null; worst: Row | null } {
  const coins = Object.entries(bySymbol).sort(([, a], [, b]) => b.pnlNet - a.pnlNet)
  const first = coins[0]
  const last = coins.at(-1)
  const row = (label: string, [symbol, s]: (typeof coins)[number]) => ({ label, value: `${coinName(symbol)} · ${formatResult(s.pnlNet)}` })
  return {
    best: first && first[1].pnlNet > 0 ? row('Mejor moneda', first) : null,
    worst: last && last[1].pnlNet < 0 ? row('Peor moneda', last) : null,
  }
}

function reportRows({ session, stats, realized }: Pick<SessionReportProps, 'session' | 'stats' | 'realized'>): Row[] {
  const { costs } = stats
  const replay = session.kind === 'replay'
  const totalCosts = costs.fees + costs.spread + costs.slippage + costs.funding
  const { best, worst } = coinExtremes(stats.bySymbol)
  const rows: (Row | null)[] = [
    { label: 'Operaciones', value: `${stats.trades} · ${stats.wins} ganadas y ${stats.losses} perdidas` },
    { label: 'Ganancia neta', value: `${formatResult(realized)} (ROI ${formatPct(realized / session.capitalInicial, 1)})` },
    { label: 'Factor de beneficio', value: stats.profitFactor === null ? 'sin pérdidas' : formatNumber(stats.profitFactor, 2) },
    { label: 'Expectativa', value: `${formatSigned(stats.expectancyR, 2)}R por operación` },
    {
      label: 'Drawdown máximo',
      // En un replay la curva es por vela y se toma el peor precio de cada una (spec §9).
      value: `${formatPct(stats.maxDrawdown.pct, 1, false)}${replay ? ' · por vela, peor caso' : ''}`,
    },
    best,
    worst,
    {
      label: 'Costos',
      // El funding positivo es pagado (un costo); negativo, cobrado.
      value: `${formatUsd(totalCosts)}: comisiones ${formatUsd(costs.fees)}, spread ${formatUsd(costs.spread)}, slippage ${formatUsd(costs.slippage)}, funding ${costs.funding >= 0 ? formatUsd(costs.funding) : `cobrado ${formatUsd(-costs.funding)}`}`,
    },
    { label: 'Costo medio / riesgo medio', value: `${formatNumber(stats.costPerRiskR, 2)}R` },
  ]
  return rows.filter((r): r is Row => r !== null)
}

/**
 * El reporte de un replay o de una simulación archivada, en lugar del estado del bot
 * (spec §9, §11.1 contexto de sesión): los números que deciden si sirvió y, en un replay,
 * los trades por quincena, lo que hay que saber para leerlo (sesgo de supervivencia,
 * señales que faltaron) y una hoja con el histograma de S′, la correlación entre señales
 * y el universo por día.
 */
export function SessionReport({ session, stats, realized, report, now, statsHref, className }: SessionReportProps) {
  const sheet = useUrlSheet(SHEET_PARAM, 'detalle')
  const hydrated = useHydrated()
  const replay = session.kind === 'replay'
  const intro = replay && session.replayParams ? `Se corrió con ${replayParamsLabel(session.replayParams)}.` : null
  const fortnights = report?.fortnights ?? []

  return (
    <Section
      title="Reporte"
      className={className}
      action={
        <Link href={statsHref} className="-my-2.5 -mr-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium text-muted hover:text-ink">
          Ver estadísticas
        </Link>
      }
    >
      {/* El mensaje final del bot es el veredicto, que ya está bajo el titular. */}
      {intro && <p className="text-[0.9375rem] text-pretty text-muted">{intro}</p>}
      {stats.trades === 0 ? (
        <p className="panel p-4 text-muted">No cerró ninguna operación: no hay números para el reporte.</p>
      ) : (
        <dl className="panel flex flex-col px-4">
          {reportRows({ session, stats, realized }).map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 border-t border-line py-2.5 first:border-t-0 desktop:flex-row desktop:justify-between desktop:gap-6">
              <dt className="shrink-0 text-sm text-muted">{row.label}</dt>
              <dd className="text-[0.9375rem] text-pretty tabular-nums desktop:text-right">{glue(row.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {replay && (
        <div className="mt-4 flex flex-col gap-6">
          {fortnights.some((f) => f.trades > 0) && <ReportFortnights fortnights={fortnights} now={now} />}
          <ReportCaveats report={report} now={now} />
          {report && report.missingSignals.length > 0 && <MissingSignals missing={report.missingSignals} now={now} />}
          {report && (
            <Button size="sm" onClick={sheet.show} className="self-start">
              Ver señales y universo
            </Button>
          )}
        </div>
      )}
      {report && <ReportSheet open={hydrated && sheet.open} onClose={sheet.hide} report={report} now={now} />}
    </Section>
  )
}
