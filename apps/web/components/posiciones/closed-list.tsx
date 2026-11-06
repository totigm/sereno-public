'use client'

import clsx from 'clsx'
import Link from 'next/link'
import type { MouseEvent } from 'react'
import type { PosicionesData } from '@/lib/queries/posiciones'
import { ClosedRow, CLOSED_COLUMNS } from './closed-row'
import { FILTER_KEYS } from './filters'
import { dayLabel } from './format'
import type { TradeScope } from './trade-model'
import { useQueryNav } from './use-query-nav'

export interface ClosedListProps {
  closed: PosicionesData['closed']
  scope: TradeScope
  hrefFor: (id: string) => string
  onOpen: (event: MouseEvent, id: string) => void
  /** Hay filtros puestos: el vacío dice que no hay coincidencias, no que no hubo trades. */
  filtered: boolean
  /** Llegan datos nuevos (cambió un filtro o la página): lo de antes queda atenuado. */
  pending: boolean
}

type DayGroup = { day: number; items: PosicionesData['closed']['items'] }

function byDay(items: PosicionesData['closed']['items']): DayGroup[] {
  const groups: DayGroup[] = []
  for (const item of items) {
    const last = groups.at(-1)
    if (last?.day === item.day) last.items.push(item)
    else groups.push({ day: item.day, items: [item] })
  }
  return groups
}

/** El historial de cerradas agrupado por día (spec §11.1), lo más nuevo primero, de a 50. */
export function ClosedList({ closed, scope, hrefFor, onOpen, filtered, pending }: ClosedListProps) {
  const nav = useQueryNav()

  if (closed.items.length === 0) {
    return (
      <div className="panel flex flex-col items-start gap-3 p-5">
        <p className="font-medium">
          {filtered
            ? 'Ninguna operación cerrada con estos filtros.'
            : scope.active
              ? 'Acá van a aparecer las operaciones cerradas'
              : 'Esta sesión no cerró operaciones.'}
        </p>
        {filtered && (
          <Link
            href={nav.hrefWith({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), pagina: null })}
            scroll={false}
            className="text-sm font-semibold underline underline-offset-4"
          >
            Quitar filtros
          </Link>
        )}
      </div>
    )
  }

  const { page } = closed
  return (
    <div aria-busy={pending || undefined} className={clsx('transition-opacity duration-150', pending && 'opacity-60')}>
      <div aria-hidden className={clsx('mb-2 hidden h-9 text-sm text-muted', CLOSED_COLUMNS)}>
        <span>Moneda y resultado en US$</span>
        <span>Por qué cerró</span>
        <span>Entrada → salida</span>
        <span className="text-right">Duró</span>
        <span className="text-right">R</span>
        <span className="text-right">Hora</span>
      </div>
      <div className="flex flex-col gap-6">
        {byDay(closed.items).map((group) => (
          <section key={group.day} aria-label={dayLabel(group.day, scope.clock)}>
            <h3 className="border-b border-line pb-2 text-sm font-semibold">{dayLabel(group.day, scope.clock)}</h3>
            <ul className="divide-y divide-line">
              {group.items.map((trade) => (
                <ClosedRow key={trade.id} trade={trade} href={hrefFor(trade.id)} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {(page > 1 || closed.hasMore) && (
        <nav aria-label="Páginas del historial" className="mt-6 flex justify-between gap-3">
          {page > 1 ? (
            <Link href={nav.hrefWith({ pagina: page === 2 ? null : String(page - 1), trade: null })} className="inline-flex h-11 items-center text-sm font-semibold underline-offset-4 hover:underline">
              Más recientes
            </Link>
          ) : (
            <span />
          )}
          {closed.hasMore && (
            <Link href={nav.hrefWith({ pagina: String(page + 1), trade: null })} className="inline-flex h-11 items-center text-sm font-semibold underline-offset-4 hover:underline">
              Más antiguas
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
