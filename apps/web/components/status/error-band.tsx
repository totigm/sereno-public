'use client'

import { Button } from '@/components/ui/button'
import { formatTimeBA } from '@/lib/format'
import { useLiveContext } from '@/lib/live/provider'
import { Band } from './band'

export interface ErrorBandProps {
  error: Error | null
  /** Cuándo llegó el último dato que sigue en pantalla (ms). */
  updatedAt: number
  onRetry: () => void
  retrying: boolean
}

/** "No pude leer la base. Último dato 14:32. [Reintentar]", con los últimos datos visibles abajo (spec §11.4). */
export function ErrorBand({ error, updatedAt, onRetry, retrying }: ErrorBandProps) {
  return (
    <Band
      show={error !== null}
      tone="loss"
      role="alert"
      action={
        <Button size="sm" variant="secondary" pending={retrying} onClick={onRetry} className="-my-1.5 self-center">
          Reintentar
        </Button>
      }
    >
      No pude leer la base. Último dato {formatTimeBA(updatedAt)}.
    </Band>
  )
}

/** La banda de error conectada a la consulta en vivo de la pantalla. */
export function LiveErrorBand() {
  const { error, updatedAt, refetch, isFetching } = useLiveContext()
  return <ErrorBand error={error} updatedAt={updatedAt} onRetry={() => void refetch()} retrying={isFetching} />
}
