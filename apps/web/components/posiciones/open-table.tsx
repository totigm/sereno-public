'use client'

import clsx from 'clsx'
import Link from 'next/link'
import { Fragment, type MouseEvent } from 'react'
import { Button } from '@/components/ui/button'
import { formatTimeBA } from '@/lib/format'
import type { OpenPositionView } from '@/lib/live/types'
import { useClosePosition } from './close-position'
import { CloseStatusLine, isClosing } from './close-status'
import { durationLabel, formatPrice } from './format'
import { StopTpBar } from './stop-tp-bar'
import { TradeHead } from './trade-head'
import { summarize, type TradeScope } from './trade-model'

export interface OpenTableProps {
  open: OpenPositionView[]
  scope: TradeScope
  hrefFor: (id: string) => string
  onOpen: (event: MouseEvent, id: string) => void
  /** Las filas llevan el id de la transición compartida (sólo si la tabla es lo visible). */
  shared: boolean
  className?: string
}

const COLUMNS = 'grid grid-cols-[minmax(18rem,2.4fr)_1fr_1fr_0.7fr_minmax(9rem,1.6fr)_8.5rem] items-center gap-x-5'
const COLUMN_COUNT = 6

function priceHeader(scope: TradeScope): string {
  if (!scope.active) return 'Al final'
  if (scope.offline && scope.pricesAt !== null) return `A las ${formatTimeBA(scope.pricesAt)}`
  return 'Ahora'
}

/** Las abiertas en desktop (spec §11.1): tabla con numerales tabulares; la fila entera abre la hoja. */
export function OpenTable({ open, scope, hrefFor, onOpen, shared, className }: OpenTableProps) {
  const close = useClosePosition()
  const stale = scope.offline
  const withActions = close.available || close.unavailableReason !== null

  return (
    <div role="table" aria-label="Posiciones abiertas" className={clsx('panel px-5', className)}>
      <div role="rowgroup">
        <div role="row" className={clsx(COLUMNS, 'h-11 text-sm text-muted')}>
          <span role="columnheader">Moneda y resultado en US$</span>
          <span role="columnheader" className="text-right">Entrada</span>
          <span role="columnheader" className="text-right">{priceHeader(scope)}</span>
          <span role="columnheader" className="text-right">Abierta</span>
          <span role="columnheader">Stop ─ take profit</span>
          <span role="columnheader" className="sr-only">Acciones</span>
        </div>
      </div>
      <div role="rowgroup">
        {open.map((position) => {
          const summary = summarize(position)
          const status = close.statusOf(position.symbol)
          return (
            <Fragment key={position.id}>
              <div role="row" className={clsx(COLUMNS, 'relative border-t border-line tabular-nums')}>
                <span role="cell" className="flex h-14 min-w-0 items-center">
                  <Link
                    href={hrefFor(position.id)}
                    scroll={false}
                    onClick={(event) => onOpen(event, position.id)}
                    className="block min-w-0 flex-1 after:absolute after:inset-0 after:content-[''] hover:after:bg-ink/3 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-ink"
                  >
                    <TradeHead summary={summary} shared={shared} stale={stale} dense />
                  </Link>
                </span>
                <span role="cell" className="text-right">{formatPrice(position.entryPrice)}</span>
                <span role="cell" className={clsx('text-right', stale && 'text-muted')}>
                  {summary.price === null ? '—' : formatPrice(summary.price)}
                </span>
                <span role="cell" className="text-right text-muted">{durationLabel(scope.now - position.openedAt)}</span>
                <span role="cell">
                  <StopTpBar
                    side={position.side}
                    entry={position.entryPrice}
                    stop={position.stopPrice}
                    takeProfit={position.takeProfitPrice}
                    liquidation={position.liquidationPrice}
                    price={summary.price}
                    stale={stale}
                    compact
                  />
                </span>
                <span role="cell" className="relative z-10 flex justify-end">
                  {withActions && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!close.available || isClosing(status)}
                      title={close.unavailableReason ?? undefined}
                      onClick={() => close.request(position)}
                    >
                      Cerrar ahora
                    </Button>
                  )}
                </span>
              </div>
              {/* El estado del cierre, debajo y a todo el ancho: una fila propia de una sola celda. */}
              {status && (
                <div role="row">
                  <span role="cell" aria-colspan={COLUMN_COUNT} className="block">
                    <CloseStatusLine position={position} className="-mt-1 pb-2" />
                  </span>
                </div>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
