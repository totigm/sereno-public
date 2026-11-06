import clsx from 'clsx'
import { Fragment } from 'react'
import { capitalize } from '@sereno/core/src/journal/format'
import type { HeadlineView } from '@/lib/derive'
import { formatSigned, formatTimeBA } from '@/lib/format'

// "Cerrado +247,80 · abierto −52,10 · hoy +38,20 · 14 de 23 ganados" (spec §11.1): lo que
// arma el titular, por partes. Cada número lleva su signo, así no depende sólo del color.

export type PartTone = 'gain' | 'loss' | 'ink' | 'muted'

export interface SummaryPart {
  key: string
  label: string
  value: string | null
  tone: PartTone
}

export interface SecondaryContext {
  /** Replay o archivada: sin "hoy" y con "abierto al final". */
  past: boolean
  openCount: number
  /** Sin conexión y con abiertas: hora de los precios con que están valuadas. */
  pricesAt: number | null
}

const signTone = (n: number): PartTone => (formatSigned(n) === formatSigned(0) ? 'ink' : n > 0 ? 'gain' : 'loss')

/** Sin operaciones todavía no hay nada que desglosar: la línea no aparece. */
export function secondaryParts(view: HeadlineView, { past, openCount, pricesAt }: SecondaryContext): SummaryPart[] {
  if (!view.hasTrades) return []
  const stale = pricesAt !== null
  const parts: SummaryPart[] = []
  if (view.closedCount > 0) parts.push({ key: 'closed', label: 'cerrado', value: formatSigned(view.realized), tone: signTone(view.realized) })
  if (openCount > 0) {
    parts.push({
      key: 'open',
      label: past ? 'abierto al final' : 'abierto',
      value: formatSigned(view.unrealized),
      tone: stale ? 'muted' : signTone(view.unrealized),
    })
  }
  if (!past) parts.push({ key: 'today', label: 'hoy', value: formatSigned(view.today), tone: stale ? 'muted' : signTone(view.today) })
  if (view.closedCount > 0) parts.push({ key: 'won', label: `${view.wonCount} de ${view.closedCount} ganados`, value: null, tone: 'ink' })
  if (pricesAt !== null) parts.push({ key: 'prices', label: `precios de las ${formatTimeBA(pricesAt)}`, value: null, tone: 'muted' })
  return parts.map((part, i) => (i === 0 ? { ...part, label: capitalize(part.label) } : part))
}

const NBSP = '\u00a0'

const TONES: Record<PartTone, string> = { gain: 'text-gain', loss: 'text-loss', ink: 'text-ink', muted: 'text-muted' }

/** La línea de abajo del titular; sin operaciones todavía no se muestra. */
export function SecondaryLine({ parts, className }: { parts: SummaryPart[]; className?: string | undefined }) {
  if (parts.length === 0) return null
  return (
    <p className={clsx('text-[0.9375rem] text-muted', className)}>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {/* El punto queda pegado a lo anterior: un renglón nunca empieza con "·". */}
          {i > 0 && `${NBSP}· `}
          <span className="whitespace-nowrap">
            {part.value === null ? (
              part.label
            ) : (
              <>
                {part.label} <span className={clsx('font-medium', TONES[part.tone])}>{part.value}</span>
              </>
            )}
          </span>
        </Fragment>
      ))}
    </p>
  )
}
