'use client'

import { useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { parseCapital } from '@/lib/amount'
import { confirmText } from '@/lib/real-copy'

export interface TypedConfirmProps {
  open: boolean
  onClose: () => void
  /** Recibe lo escrito tal cual: el servidor vuelve a compararlo con el monto. */
  onConfirm: (typed: string) => void
  title: string
  /** El monto que hay que escribir. */
  capital: number
  confirmLabel: string
  pending: boolean
}

/**
 * La confirmación de la plata real (spec real §Cómo se prende): no alcanza con un toque,
 * hay que escribir el monto. El botón se habilita recién cuando lo escrito es el monto.
 */
export function TypedConfirm({ open, onClose, onConfirm, title, capital, confirmLabel, pending }: TypedConfirmProps) {
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  // Cada vez que se abre arranca vacía, también después de una confirmación que salió bien
  // (el padre la cierra sin pasar por Cancelar): un monto viejo habilitaría el botón de un toque.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTyped('')
  }
  const matches = parseCapital(typed) === capital

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (matches) onConfirm(typed)
  }

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label htmlFor={inputId} className="text-muted text-pretty">
          {confirmText(capital)}
        </label>
        <div className="flex h-11 items-center gap-2 rounded-control border border-line bg-surface px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink">
          <span className="shrink-0 text-muted">US$</span>
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent tabular-nums outline-none"
          />
        </div>
        <div className="flex flex-col gap-2 desktop:flex-row-reverse">
          <Button type="submit" variant="danger" disabled={!matches} pending={pending} className="desktop:flex-1">
            {confirmLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending} className="desktop:flex-1">
            Cancelar
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
