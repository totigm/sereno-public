'use client'

import type { MouseEvent } from 'react'
import type { OpenPositionView } from '@/lib/live/types'
import { DESKTOP_QUERY } from '@/lib/theme'
import { useMediaQuery } from '@/lib/use-media-query'
import { useClosePosition } from './close-position'
import { OpenCard } from './open-card'
import { OpenTable } from './open-table'
import type { TradeScope } from './trade-model'

export interface OpenPositionsProps {
  open: OpenPositionView[]
  scope: TradeScope
  hrefFor: (id: string) => string
  onOpen: (event: MouseEvent, id: string) => void
}

/**
 * Las abiertas: tarjetas en el celu y tabla en desktop. Las dos se renderizan (el
 * servidor no sabe el ancho) y el CSS muestra una; la transición compartida va sólo
 * en la visible, así la hoja nunca sale desde una caja oculta.
 */
export function OpenPositions({ open, scope, hrefFor, onOpen }: OpenPositionsProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const { unavailableReason } = useClosePosition()

  if (open.length === 0) {
    return (
      <p className="panel p-5 text-muted">
        {scope.active ? 'Ninguna operación abierta ahora. Cuando el bot abra una, aparece acá con su stop y su objetivo.' : 'No quedaron operaciones abiertas al final.'}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {unavailableReason && <p className="text-sm text-muted">{unavailableReason}</p>}
      <ul aria-label="Posiciones abiertas" className="flex flex-col gap-3 desktop:hidden">
        {open.map((position) => (
          <li key={position.id}>
            <OpenCard position={position} scope={scope} href={hrefFor(position.id)} onOpen={onOpen} shared={!desktop} />
          </li>
        ))}
      </ul>
      <OpenTable open={open} scope={scope} hrefFor={hrefFor} onOpen={onOpen} shared={desktop} className="hidden desktop:block" />
    </div>
  )
}
