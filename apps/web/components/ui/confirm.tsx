'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'

export type ConfirmProps = {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  /** Qué va a pasar, con el número adentro: "Vas a cerrar 3 posiciones por −US$ 8,40". */
  description: ReactNode
  /** Verbo activo: "Cerrar ahora", "Reiniciar aprendizaje". */
  confirmLabel: string
  cancelLabel?: string
  pending?: boolean
}

/** Confirmación sólo para lo destructivo (spec §11.1); lo demás va con toast y "Deshacer". */
export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  pending = false,
}: ConfirmProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="text-muted">{description}</p>
      <div className="mt-5 flex flex-col gap-2 desktop:flex-row-reverse">
        <Button variant="danger" onClick={onConfirm} pending={pending} className="desktop:flex-1">
          {confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={pending} className="desktop:flex-1">
          {cancelLabel}
        </Button>
      </div>
    </Sheet>
  )
}
