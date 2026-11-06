'use client'

import clsx from 'clsx'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { useToast } from '@/components/ui/toast'
import { resetLearning } from '@/lib/actions/commands'
import { plural } from './labels'
import { offlineNoteText } from './offline-note'
import { COMPACT_ON_DESKTOP } from './touch'

export interface ResetLearningProps {
  sessionId: string
  /** Trades cerrados de los que aprendió: lo que se pierde, dicho en la confirmación. */
  closedTrades: number
  label: string
  /** Sin el bot no se pide (spec §11.1): el botón queda apagado y lo explica el elemento `offlineNoteId`. */
  offline: boolean
  offlineNoteId: string
  className?: string
  /** El id del comando encolado, para seguir su estado ("enviado al bot… ✓ aplicado"). */
  onQueued?: (commandId: string) => void
}

/**
 * "Reiniciar aprendizaje" (spec §8): destructivo, con confirmación. Es un comando al
 * bot y no queda en cola para cuando vuelva: un reinicio que llega horas después
 * puede caer sobre un aprendizaje que ya no es el que se quiso borrar.
 */
export function ResetLearning({ sessionId, closedTrades, label, offline, offlineNoteId, className, onQueued }: ResetLearningProps) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const confirm = async () => {
    // El bot puede quedarse sin conexión con la confirmación abierta.
    if (offline) {
      setOpen(false)
      toast({ message: offlineNoteText('reiniciar') })
      return
    }
    setPending(true)
    const result = await resetLearning({ id: crypto.randomUUID(), sessionId })
    setPending(false)
    if (!result.ok) {
      toast({ message: result.message })
      return
    }
    setOpen(false)
    onQueued?.(result.id)
    toast({ message: 'Pedí reiniciar el aprendizaje.' })
  }

  const lost = closedTrades > 0 ? ` Lo aprendido en ${plural(closedTrades, 'trade', 'trades')} se pierde; el diario queda.` : ' El diario queda.'
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={offline}
        aria-describedby={offline ? offlineNoteId : undefined}
        className={clsx(COMPACT_ON_DESKTOP, className)}
      >
        {label}
      </Button>
      <Confirm
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => void confirm()}
        pending={pending}
        title="Reiniciar aprendizaje"
        description={`Los pesos de las señales, la confianza en cada moneda y los parámetros vuelven a los de fábrica.${lost}`}
        confirmLabel="Reiniciar aprendizaje"
      />
    </>
  )
}
