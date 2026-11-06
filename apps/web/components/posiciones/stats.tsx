import clsx from 'clsx'
import type { ReactNode } from 'react'
import { formatDateBA, formatNumber, formatPct, formatSigned, formatUsd } from '@/lib/format'
import type { StatsView } from '@/lib/queries/stats'
import { formatResult } from './format'
import { SymbolStats } from './symbol-stats'

const RESOLUTION: Record<'minute' | 'event', string> = { minute: 'medido por minuto', event: 'medido en cada operación' }

function drawdownNote(dd: StatsView['maxDrawdown']): string | null {
  if (dd.resolution === null) return null
  const span = dd.peakAt !== null && dd.troughAt !== null ? `, del ${formatDateBA(dd.peakAt)} al ${formatDateBA(dd.troughAt)}` : ''
  return `${RESOLUTION[dd.resolution]}${span}`
}

function Figure({ label, value, note, wide = false }: { label: string; value: ReactNode; note?: string | null; wide?: boolean }) {
  return (
    <div className={clsx('flex flex-col gap-0.5 bg-surface p-4', wide && 'col-span-2 desktop:col-span-1')}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-lg leading-snug font-semibold tracking-[-0.01em]">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  )
}

/** Celdas separadas por la línea de 1 px: el hueco de la grilla deja ver el color de la línea. */
function Figures({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line desktop:grid-cols-5">
      {children}
    </dl>
  )
}

/** Las estadísticas de la sesión (spec §11.1, Posiciones). */
export function Stats({ stats }: { stats: StatsView }) {
  if (stats.trades === 0) {
    return <p className="panel p-5 text-muted">Las estadísticas aparecen con la primera operación cerrada.</p>
  }
  const { costs } = stats
  const fundingPaid = costs.funding >= 0
  return (
    <div className="flex flex-col gap-8">
      <Figures label="Resultados">
        <Figure label="Ganadas y perdidas" value={`${stats.wins} y ${stats.losses}`} />
        <Figure label="Tasa de acierto" value={formatPct(stats.winRate, 1, false)} />
        <Figure label="Factor de beneficio" value={stats.profitFactor === null ? 'Sin pérdidas' : formatNumber(stats.profitFactor, 2)} />
        <Figure label="Expectativa" value={`${formatSigned(stats.expectancyR, 2)}R`} note="por operación" />
        <Figure label="Ganancia media" value={stats.wins === 0 ? '—' : formatResult(stats.avgWin)} />
        <Figure label="Pérdida media" value={stats.losses === 0 ? '—' : formatResult(stats.avgLoss)} />
        <Figure label="Mejor operación" value={formatResult(stats.bestTrade)} />
        <Figure label="Peor operación" value={formatResult(stats.worstTrade)} />
        <Figure label="Drawdown máximo" value={formatPct(stats.maxDrawdown.pct, 1, false)} note={drawdownNote(stats.maxDrawdown)} />
        <Figure label="Liquidaciones" value={String(stats.liquidations)} />
      </Figures>

      <section className="flex flex-col gap-3">
        <h3 className="font-medium">Costos</h3>
        <Figures label="Costos">
          <Figure label="Comisiones" value={formatUsd(costs.fees)} />
          <Figure label="Spread" value={formatUsd(costs.spread)} />
          <Figure label="Slippage" value={formatUsd(costs.slippage)} />
          <Figure label={fundingPaid ? 'Funding pagado' : 'Funding cobrado'} value={formatUsd(Math.abs(costs.funding))} />
          <Figure
            label="Costo medio / riesgo medio"
            wide
            value={`${formatNumber(stats.costPerRiskR, 2)}R`}
            note="lo que se llevan los costos de cada R arriesgado"
          />
        </Figures>
      </section>

      <SymbolStats bySymbol={stats.bySymbol} />
    </div>
  )
}
