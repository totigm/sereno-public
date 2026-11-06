import clsx from 'clsx'
import { REAL_CHECK_LABELS, type RealCheck } from '@sereno/shared'
import { formatTimeBA } from '@/lib/format'
import { STALE_TEXT } from '@/lib/real-copy'
import type { ReadinessView } from '@/lib/real-readiness'
import { RowFrame } from './setting-row'

const DOT: Record<RealCheck['status'], string> = { ok: 'bg-gain', fail: 'bg-loss', skipped: 'bg-muted/50' }
const STATUS: Record<RealCheck['status'], string> = { ok: 'Bien', fail: 'Falla', skipped: 'No aplica' }

/**
 * Los chequeos que corrió el bot sobre la cuenta de Binance, uno por fila con su estado.
 * Un chequeo que falla o que no aplica dice por qué; los que pasan, sólo su nombre.
 */
export function RealChecks({ readiness }: { readiness: ReadinessView | null }) {
  if (readiness === null) {
    return (
      <RowFrame>
        <p className="text-sm text-muted text-pretty">
          El bot todavía no revisó tu cuenta de Binance. Lo hace al arrancar y cada 5 minutos: en la Mac, <code>pnpm bot</code>.
        </p>
      </RowFrame>
    )
  }
  return (
    <RowFrame>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <p className="font-medium">Chequeos de la cuenta</p>
        <p className="text-sm text-muted tabular-nums">Última revisión {formatTimeBA(readiness.checkedAt)}</p>
      </div>
      {readiness.stale && <p className="mt-1 text-sm text-loss text-pretty">{STALE_TEXT}</p>}
      <ul aria-label="Chequeos de la cuenta" className={clsx('mt-2 flex flex-col gap-2 text-sm', readiness.stale && 'opacity-70')}>
        {readiness.checks.map((check) => (
          <li key={check.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2">
            <span aria-hidden className={clsx('mt-[0.4375rem] size-1.5 rounded-full', DOT[check.status])} />
            <span className={clsx(check.status === 'skipped' && 'text-muted')}>
              <span className="sr-only">{STATUS[check.status]}: </span>
              {REAL_CHECK_LABELS[check.id]}
              {check.status !== 'ok' && check.detail !== '' && (
                <span className={clsx('block text-pretty', check.status === 'fail' ? 'text-loss' : 'text-muted')}>{check.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </RowFrame>
  )
}
