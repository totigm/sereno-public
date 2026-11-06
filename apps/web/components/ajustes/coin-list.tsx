'use client'

import { useId } from 'react'
import { RowFrame } from './setting-row'

export interface CoinOption {
  symbol: string
  name: string
}

export interface CoinListProps {
  label: string
  description: string
  symbols: readonly string[]
  /** Las que se pueden agregar (sin las que ya están en esta lista). */
  options: readonly CoinOption[]
  nameOf: (symbol: string) => string
  /** "Fijar una moneda": nombre del selector y su primera opción. */
  addLabel: string
  /** "Sacar SOL de las fijadas". */
  removeLabel: (name: string) => string
  emptyText: string
  readOnly: boolean
  onAdd: (symbol: string) => void
  onRemove: (symbol: string) => void
}

function RemoveIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 text-muted">
      <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Una lista de monedas que se arma a mano (fijadas, excluidas): fichas que se sacan con
 * un toque y un selector nativo para agregar (en el celu abre la rueda del sistema).
 */
export function CoinList({ label, description, symbols, options, nameOf, addLabel, removeLabel, emptyText, readOnly, onAdd, onRemove }: CoinListProps) {
  const labelId = useId()
  return (
    <RowFrame>
      <div className="flex flex-col gap-3">
        <div>
          <span id={labelId} className="block font-medium">
            {label}
          </span>
          <p className="text-sm text-muted text-pretty">{description}</p>
        </div>
        {symbols.length === 0 ? (
          <p className="text-sm text-muted">{emptyText}</p>
        ) : (
          <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
            {symbols.map((symbol) => (
              <li key={symbol}>
                {readOnly ? (
                  <span className="inline-flex h-9 items-center rounded-chip border border-line px-3 text-sm font-medium">{nameOf(symbol)}</span>
                ) : (
                  // El área táctil pasa los 44 px con el borde invisible de `after`.
                  <button
                    type="button"
                    aria-label={removeLabel(nameOf(symbol))}
                    onClick={() => onRemove(symbol)}
                    className="pressable relative inline-flex h-9 items-center gap-1.5 rounded-chip border border-line bg-surface pr-2.5 pl-3 text-sm font-medium after:absolute after:-inset-1 after:content-[''] hover:bg-ink/4"
                  >
                    {nameOf(symbol)}
                    <RemoveIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <div className="relative w-full desktop:max-w-64">
            <select
              aria-label={addLabel}
              value=""
              onChange={(event) => {
                if (event.target.value !== '') onAdd(event.target.value)
              }}
              className="h-11 w-full cursor-pointer appearance-none rounded-control border border-line bg-surface pr-9 pl-3 text-[0.9375rem]"
            >
              <option value="" disabled>
                {addLabel}…
              </option>
              {options.map((option) => (
                <option key={option.symbol} value={option.symbol}>
                  {option.name}
                </option>
              ))}
            </select>
            <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
      </div>
    </RowFrame>
  )
}
