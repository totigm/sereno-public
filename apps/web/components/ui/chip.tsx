import clsx from 'clsx'
import type { ReactNode } from 'react'
import { LOSS_FILL } from './loss-fill'

export type ChipTone = 'gain' | 'loss' | 'muted' | 'info' | 'alert'

export type ChipProps = {
  tone?: ChipTone
  /** Punto al inicio, para estados ("En vivo", "Sin conexión"). */
  dot?: boolean
  className?: string
  children: ReactNode
}

/**
 * El rojo lleno de la plata real (spec real §Dashboard), que ningún otro chip usa, para que
 * no se confunda con un resultado negativo.
 */
export const ALERT_FILL = LOSS_FILL

const tones: Record<ChipTone, string> = {
  gain: 'bg-gain-soft text-gain',
  loss: 'bg-loss-soft text-loss',
  muted: 'bg-muted/12 text-muted',
  info: 'bg-ink/8 text-ink',
  alert: ALERT_FILL,
}

export function Chip({ tone = 'muted', dot = false, className, children }: ChipProps) {
  return (
    <span
      data-tone={tone}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs leading-5 font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  )
}
