import clsx from 'clsx'
import { useId } from 'react'
import {
  VERDICT_MAX_DRAWDOWN,
  VERDICT_MAX_SHADOW_GAP_PP,
  VERDICT_MIN_PROFIT_FACTOR,
  VERDICT_RESAMPLES,
  type VerdictStatus,
} from '@sereno/core/src/stats/verdict'
import { formatNumber, formatPct, formatSigned } from '@/lib/format'
import { VERDICT_MIN_DAYS, VERDICT_MIN_TRADES, type VerdictView } from '@/lib/queries/stats'

export interface VerdictCardProps {
  verdict: VerdictView
  /** Días que lleva la sesión (o los del replay): el otro mínimo de la muestra. */
  days: number
}

const STATUS_TITLE: Record<VerdictStatus, string> = {
  insufficient: 'Todavía no se puede saber.',
  edge: 'Ventaja positiva.',
  no_edge: 'Sin ventaja demostrada.',
}

type Check = 'met' | 'unmet' | 'unknown'

const CHECK_TEXT: Record<Check, string> = { met: 'cumple', unmet: 'no cumple', unknown: 'sin evaluar' }

const formatR = (r: number) => `${formatSigned(r, 2)}R`

function criteria(v: VerdictView): { label: string; value: string; check: Check }[] {
  const [lo, hi] = v.ci95
  const empty = v.trades === 0
  return [
    {
      label: 'Expectativa por operación mayor a 0, con 95% de confianza',
      value: empty ? '—' : `${formatR(v.expectancyR)} (entre ${formatR(lo)} y ${formatR(hi)})`,
      check: empty ? 'unknown' : lo > 0 ? 'met' : 'unmet',
    },
    {
      label: `Factor de beneficio de ${formatNumber(VERDICT_MIN_PROFIT_FACTOR, 1)} o más`,
      value: empty ? '—' : v.profitFactor === null ? 'sin pérdidas' : formatNumber(v.profitFactor, 2),
      check: empty ? 'unknown' : v.profitFactor === null || v.profitFactor >= VERDICT_MIN_PROFIT_FACTOR ? 'met' : 'unmet',
    },
    {
      label: `Drawdown máximo de ${formatPct(VERDICT_MAX_DRAWDOWN, 0, false)} o menos`,
      value: formatPct(v.maxDrawdownPct, 1, false),
      check: v.maxDrawdownPct <= VERDICT_MAX_DRAWDOWN ? 'met' : 'unmet',
    },
    {
      label: `Lo aprendido no rinde más de ${VERDICT_MAX_SHADOW_GAP_PP} puntos por debajo de los pesos originales`,
      value: v.shadowGapPp === null ? 'sin muestra todavía' : `${formatSigned(v.shadowGapPp, 1)} pp`,
      check: v.shadowGapPp === null ? 'unknown' : v.shadowGapPp >= -VERDICT_MAX_SHADOW_GAP_PP ? 'met' : 'unmet',
    },
  ]
}

function CheckMark({ check }: { check: Check }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
        check === 'met' ? 'bg-gain-soft text-gain' : check === 'unmet' ? 'bg-loss-soft text-loss' : 'bg-ink/6 text-muted',
      )}
    >
      <svg viewBox="0 0 12 12" className="size-3">
        {check === 'met' && <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        {check === 'unmet' && <path d="M3.5 3.5l5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
        {check === 'unknown' && <path d="M3.5 6h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      </svg>
    </span>
  )
}

function Progress({ label, done, goal, missing }: { label: string; done: number; goal: number; missing: string | null }) {
  const fraction = Math.min(1, done / goal)
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted tabular-nums">
          <span>
            {formatNumber(Math.floor(done), 0)} de {goal}
          </span>
          {missing !== null && (
            <>
              <span aria-hidden> · </span>
              <span>{missing}</span>
            </>
          )}
        </span>
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-valuenow={Math.min(goal, Math.floor(done))}
        className="h-1.5 overflow-hidden rounded-chip bg-ink/8"
      >
        <div className="h-full rounded-chip bg-ink" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
    </div>
  )
}

/**
 * El veredicto completo (spec §11.6): si tiene ventaja con el criterio tal cual, cuánto
 * falta para poder decirlo y cómo viene cada condición.
 */
export function VerdictCard({ verdict, days }: VerdictCardProps) {
  const titleId = useId()
  const insufficient = verdict.status === 'insufficient'
  const missingDays = verdict.missingDays
  return (
    <section aria-labelledby={titleId} className="panel flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1.5">
        <h3 id={titleId} className="text-lg leading-tight font-semibold tracking-[-0.01em]">
          {STATUS_TITLE[verdict.status]}
        </h3>
        <p className="text-pretty text-muted">{verdict.reason}</p>
      </div>

      {insufficient && (
        <div className="flex flex-col gap-4">
          <Progress
            label="Operaciones cerradas"
            done={verdict.trades}
            goal={VERDICT_MIN_TRADES}
            missing={verdict.missingTrades > 0 ? `faltan ${verdict.missingTrades}` : null}
          />
          <Progress
            label="Días"
            done={days}
            goal={VERDICT_MIN_DAYS}
            missing={missingDays > 0 ? `faltan ${missingDays} ${missingDays === 1 ? 'día' : 'días'}` : null}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{insufficient ? 'Cómo viene, aunque todavía no cuenta' : 'Las cuatro condiciones'}</p>
        <ul className="flex flex-col gap-3">
          {criteria(verdict).map((c) => (
            <li key={c.label} className="flex gap-3 text-sm">
              <CheckMark check={c.check} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 desktop:flex-row desktop:items-baseline desktop:justify-between desktop:gap-4">
                <span>
                  {c.label}
                  <span className="sr-only">: {CHECK_TEXT[c.check]}</span>
                </span>
                <span className="text-muted tabular-nums desktop:text-right">{c.value}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="border-t border-line pt-4 text-sm text-pretty text-muted">
        Se puede decir a partir de {VERDICT_MIN_TRADES} operaciones cerradas y {VERDICT_MIN_DAYS} días. La confianza de la
        expectativa sale de remuestrear las operaciones {formatNumber(VERDICT_RESAMPLES, 0)} veces.
      </p>
    </section>
  )
}
