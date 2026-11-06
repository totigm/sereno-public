'use client'

import Link from 'next/link'
import type { MouseEvent } from 'react'
import type { OpenPositionView } from '@/lib/live/types'
import { formatTimeBA } from '@/lib/format'
import { useClosePosition } from './close-position'
import { CloseStatusLine, isClosing } from './close-status'
import { durationLabel, formatPrice } from './format'
import { StopTpBar } from './stop-tp-bar'
import { SwipeToClose } from './swipe-to-close'
import { TradeHead } from './trade-head'
import { summarize, type TradeScope } from './trade-model'

/** "ahora 148,30", "148,30 a las 14:32" (sin conexión), "al final 148,30" (sesión terminada). */
export function priceNowText(price: number | null, scope: TradeScope): string {
  if (price === null) return 'sin precio'
  if (!scope.active) return `al final ${formatPrice(price)}`
  if (scope.offline && scope.pricesAt !== null) return `${formatPrice(price)} a las ${formatTimeBA(scope.pricesAt)}`
  return `ahora ${formatPrice(price)}`
}

export interface OpenCardProps {
  position: OpenPositionView
  scope: TradeScope
  /** El link a la hoja de este trade y lo que pasa al tocarlo (ver `useTradeParam`). */
  href: string
  onOpen: (event: MouseEvent, id: string) => void
  /** Lleva el id de la transición compartida (sólo la variante visible). */
  shared: boolean
}

/**
 * La abierta en el celu (spec §11.1, Posiciones): tres líneas —"SOL · Long 5x · +US$ 12,40
 * (+4,1%)", "entró a 142,10 · ahora 148,30 · 3 h" y la barra stop ─●── TP—; tocarla abre
 * la hoja y deslizarla a la izquierda deja "Cerrar ahora".
 */
export function OpenCard({ position, scope, href, onOpen, shared }: OpenCardProps) {
  const close = useClosePosition()
  const summary = summarize(position)
  const stale = scope.offline
  const closing = isClosing(close.statusOf(position.symbol))
  const facts = [`entró a ${formatPrice(position.entryPrice)}`, priceNowText(summary.price, scope), durationLabel(scope.now - position.openedAt)]

  return (
    <SwipeToClose
      enabled={close.available || close.unavailableReason !== null}
      disabled={!close.available || closing}
      onAction={() => close.request(position)}
      className="panel"
    >
      <div className="relative flex flex-col gap-2.5 p-4">
        <p>
          <Link
            href={href}
            scroll={false}
            onClick={(event) => onOpen(event, position.id)}
            className="block after:absolute after:inset-0 after:rounded-panel after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ink"
          >
            <TradeHead summary={summary} shared={shared} stale={stale} />
          </Link>
        </p>
        <p className="text-sm text-muted tabular-nums">{facts.join(' · ')}</p>
        <StopTpBar
          side={position.side}
          entry={position.entryPrice}
          stop={position.stopPrice}
          takeProfit={position.takeProfitPrice}
          liquidation={position.liquidationPrice}
          price={summary.price}
          stale={stale}
          className="mt-1"
        />
      </div>
      <CloseStatusLine position={position} className="-mt-1 px-4 pb-2" />
    </SwipeToClose>
  )
}
