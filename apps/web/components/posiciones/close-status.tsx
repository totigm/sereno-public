'use client'

import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { OpenPositionView } from '@/lib/live/types'
import { useClosePosition, type CloseStatus } from './close-position'
import { coinName } from './format'

/** Lo que se ve del cierre pedido (spec §11.4): "Enviado al bot…", "El bot no respondió. No cerré SOL." */
export function closeStatusText(status: CloseStatus, coin: string): string {
  switch (status.kind) {
    case 'sending':
    case 'pending':
      return 'Enviado al bot…'
    case 'claimed':
      return `El bot está cerrando ${coin}…`
    case 'done':
      return status.message
    case 'failed':
      return status.message
    case 'expired':
      return `El bot no respondió. No cerré ${coin}.`
  }
}

/** Un cierre en curso no se puede pedir de nuevo: la acción se apaga hasta que se resuelve. */
export function isClosing(status: CloseStatus | null): boolean {
  return status !== null && (status.kind === 'sending' || status.kind === 'pending' || status.kind === 'claimed' || status.kind === 'done')
}

function InlineAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable -my-2 inline-flex h-9 shrink-0 items-center rounded-[8px] px-2 font-semibold text-ink hover:bg-ink/6"
    >
      {children}
    </button>
  )
}

/** La línea de estado del cierre de una abierta, con "Cancelar" mientras espera y "Reintentar" si no se cerró. */
export function CloseStatusLine({ position, className }: { position: OpenPositionView; className?: string }) {
  const { statusOf, cancel, request } = useClosePosition()
  const status = statusOf(position.symbol)
  return (
    <div role="status">
      {status && (
        <p
          className={clsx(
            'flex min-h-9 items-center justify-between gap-3 text-sm',
            className,
            status.kind === 'expired' || status.kind === 'failed' ? 'text-loss' : 'text-muted',
          )}
        >
          <span className="min-w-0">{closeStatusText(status, coinName(position.symbol))}</span>
          {status.kind === 'pending' && <InlineAction onClick={() => cancel(position.symbol)}>Cancelar</InlineAction>}
          {(status.kind === 'expired' || status.kind === 'failed') && (
            <InlineAction onClick={() => request(position)}>Reintentar</InlineAction>
          )}
        </p>
      )}
    </div>
  )
}
