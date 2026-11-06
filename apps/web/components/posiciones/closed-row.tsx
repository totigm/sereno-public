'use client'

import clsx from 'clsx'
import Link from 'next/link'
import type { MouseEvent } from 'react'
import { formatSigned, formatTimeBA } from '@/lib/format'
import type { ClosedTradeView } from '@/lib/queries/posiciones'
import { CLOSE_REASON_LABELS, durationLabel, formatPrice } from './format'
import { TradeHead } from './trade-head'
import { summarize } from './trade-model'

export interface ClosedRowProps {
  trade: ClosedTradeView
  href: string
  onOpen: (event: MouseEvent, id: string) => void
}

/** Columnas del historial en desktop; en el celu cada fila son dos líneas. */
export const CLOSED_COLUMNS = 'desktop:grid desktop:grid-cols-[minmax(18rem,2.4fr)_1.2fr_1.6fr_0.7fr_0.6fr_0.5fr] desktop:items-center desktop:gap-x-5'

/** Una cerrada del historial: moneda, lado y resultado arriba; por qué cerró, precios, duración y R. */
export function ClosedRow({ trade, href, onOpen }: ClosedRowProps) {
  const liquidated = trade.closeReason === 'liquidation'
  return (
    <li
      className={clsx(
        'relative flex flex-col gap-1 py-3 tabular-nums',
        CLOSED_COLUMNS,
        liquidated && '-mx-3 rounded-control bg-loss-soft px-3',
      )}
    >
      <Link
        href={href}
        scroll={false}
        onClick={(event) => onOpen(event, trade.id)}
        className="block min-w-0 after:absolute after:inset-0 after:rounded-control after:content-[''] hover:after:bg-ink/3 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-ink"
      >
        <TradeHead summary={summarize(trade)} shared dense />
      </Link>
      <p className="flex items-baseline justify-between gap-3 text-sm text-muted desktop:contents">
        <span className={clsx('min-w-0 truncate', liquidated && 'font-semibold text-loss')}>
          {CLOSE_REASON_LABELS[trade.closeReason]}
          <span className="desktop:hidden"> · {formatTimeBA(trade.closedAt)}</span>
        </span>
        <span className="hidden desktop:block">
          {formatPrice(trade.entryPrice)} → {formatPrice(trade.exitPrice)}
        </span>
        <span className="hidden text-right desktop:block">{durationLabel(trade.closedAt - trade.openedAt)}</span>
        <span className="text-right">{formatSigned(trade.rMultiple, 1)}R</span>
        <span className="hidden text-right desktop:block">{formatTimeBA(trade.closedAt)}</span>
      </p>
    </li>
  )
}
