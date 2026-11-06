'use client'

import clsx from 'clsx'

export interface AppliedStatusProps {
  /** La versión de los ajustes que se ve. */
  version: number
  /** La que el bot dice tener aplicada (`bot_status.settingsVersionApplied`). */
  applied: number | null
  offline: boolean
}

/** "Enviado al bot… ✓ aplicado" para los ajustes (spec §11.4); sin latido, que lo toma cuando vuelva. */
export function AppliedStatus({ version, applied, offline }: AppliedStatusProps) {
  const done = applied !== null && applied >= version
  const text = done ? 'El bot ya aplicó estos ajustes.' : offline ? 'Guardado. El bot lo toma cuando vuelva.' : 'Enviado al bot…'
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <span aria-hidden className={clsx('size-1.5 shrink-0 rounded-full', done ? 'bg-gain' : 'bg-muted')} />
      {text}
    </p>
  )
}
