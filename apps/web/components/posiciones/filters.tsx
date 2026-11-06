'use client'

import clsx from 'clsx'
import type { ChangeEvent, ReactNode } from 'react'
import type { PosicionesQuery } from '@/lib/queries/posiciones'
import { coinName } from './format'
import type { ParamsPatch } from './use-query-nav'

export interface FiltersProps {
  query: PosicionesQuery
  /** Monedas con algún trade cerrado. */
  symbols: string[]
  /** Aplica el cambio en la URL; el historial vuelve a la primera página. */
  onChange: (patch: ParamsPatch) => void
}

export const FILTER_KEYS = ['moneda', 'lado', 'resultado', 'liquidadas'] as const

export function hasFilters(query: PosicionesQuery): boolean {
  return FILTER_KEYS.some((key) => query[key] !== undefined)
}

const control =
  'h-11 rounded-chip border bg-surface text-sm font-medium transition-colors duration-150 desktop:h-9'

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  const active = value !== ''
  return (
    <span className="relative inline-flex">
      <select
        aria-label={label}
        value={value}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        className={clsx(control, 'appearance-none pr-8 pl-3.5', active ? 'border-ink text-ink' : 'border-line text-muted')}
      >
        {children}
      </select>
      <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 text-muted">
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

/** Filtros del historial (spec §11.1): moneda, lado, resultado y "liquidadas"; viven en la URL. */
export function Filters({ query, symbols, onChange }: FiltersProps) {
  const set = (key: (typeof FILTER_KEYS)[number], value: string | null) => onChange({ [key]: value === '' ? null : value })

  return (
    <div role="group" aria-label="Filtros del historial" className="flex flex-wrap items-center gap-2">
      <Select label="Moneda" value={query.moneda ?? ''} onChange={(v) => set('moneda', v)}>
        <option value="">Todas las monedas</option>
        {symbols.map((symbol) => (
          <option key={symbol} value={symbol}>
            {coinName(symbol)}
          </option>
        ))}
      </Select>
      <Select label="Lado" value={query.lado ?? ''} onChange={(v) => set('lado', v)}>
        <option value="">Long y short</option>
        <option value="long">Sólo long</option>
        <option value="short">Sólo short</option>
      </Select>
      <Select label="Resultado" value={query.resultado ?? ''} onChange={(v) => set('resultado', v)}>
        <option value="">Ganadas y perdidas</option>
        <option value="ganadas">Ganadas</option>
        <option value="perdidas">Perdidas</option>
      </Select>
      <button
        type="button"
        aria-pressed={query.liquidadas !== undefined}
        onClick={() => set('liquidadas', query.liquidadas === undefined ? '1' : null)}
        className={clsx(
          control,
          'pressable px-3.5',
          query.liquidadas === undefined ? 'border-line text-muted hover:text-ink' : 'border-loss bg-loss-soft text-loss',
        )}
      >
        Liquidadas
      </button>
    </div>
  )
}
