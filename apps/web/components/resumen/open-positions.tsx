'use client'

import Link from 'next/link'
import type { MouseEvent } from 'react'
import { useClosePosition } from '@/components/posiciones/close-position'
import { CloseStatusLine, isClosing } from '@/components/posiciones/close-status'
import { durationLabel } from '@/components/posiciones/format'
import { SwipeToClose } from '@/components/posiciones/swipe-to-close'
import { TradeHead } from '@/components/posiciones/trade-head'
import { summarize, type TradeScope } from '@/components/posiciones/trade-model'
import { formatNumber } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'
import { Section } from './section'

export interface OpenPositionsProps {
  open: readonly OpenPositionView[]
  scope: TradeScope
  hrefFor: (id: string) => string
  onOpen: (event: MouseEvent, id: string) => void
  className?: string | undefined
}

interface OpenRowProps {
  position: OpenPositionView
  scope: TradeScope
  href: string
  onOpen: OpenPositionsProps['onOpen']
}

function OpenRow({ position, scope, href, onOpen }: OpenRowProps) {
  const close = useClosePosition()
  const summary = summarize(position)
  const closing = isClosing(close.statusOf(position.symbol))
  const age = durationLabel(scope.now - position.openedAt)

  return (
    <SwipeToClose
      enabled={close.available || close.unavailableReason !== null}
      disabled={!close.available || closing}
      onAction={() => close.request(position)}
      surfaceClassName="bg-bg"
    >
      <Link
        href={href}
        scroll={false}
        onClick={(event) => onOpen(event, position.id)}
        className="flex min-h-14 items-center rounded-[8px] py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <TradeHead
          summary={summary}
          shared
          stale={scope.offline}
          withPct={false}
          detail={
            <>
              {age}
              {/* En desktop hay lugar para el margen, como en la Libreta: "SOL 3 h · US$ 50". */}
              <span className="hidden desktop:inline"> · US$&nbsp;{formatNumber(Math.round(position.margin), 0)}</span>
            </>
          }
          className="w-full"
        />
      </Link>
      <CloseStatusLine position={position} className="-mt-1 pb-2" />
    </SwipeToClose>
  )
}

/**
 * "Abiertas ahora" (spec §11.1): una fila por abierta con moneda, tiempo, lado y
 * resultado en vivo. Tocar abre la hoja del trade (la de Posiciones) con la transición
 * compartida; deslizar a la izquierda deja "Cerrar ahora" con su confirmación. En un
 * replay o una archivada son las que quedaron abiertas al final, sin acciones.
 */
export function OpenPositions({ open, scope, hrefFor, onOpen, className }: OpenPositionsProps) {
  const { unavailableReason } = useClosePosition()
  const title = scope.active ? 'Abiertas ahora' : 'Abiertas al final'

  return (
    <Section title={title} className={className}>
      {open.length === 0 ? (
        <p className="border-t border-line pt-3 text-[0.9375rem] text-pretty text-muted">
          {scope.active ? 'Ninguna por ahora. Cuando el bot abra una, aparece acá con su resultado en vivo.' : 'No quedó ninguna abierta al final.'}
        </p>
      ) : (
        <>
          <ul aria-label={title} className="flex flex-col border-b border-line">
            {open.map((position) => (
              <li key={position.id} className="border-t border-line">
                <OpenRow position={position} scope={scope} href={hrefFor(position.id)} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {unavailableReason && <p className="text-sm text-pretty text-muted">{unavailableReason}</p>}
        </>
      )}
    </Section>
  )
}
