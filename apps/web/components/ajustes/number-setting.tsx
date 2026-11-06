'use client'

import clsx from 'clsx'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { glue } from './glue'
import { ReadValue, SettingRow } from './setting-row'
import { AFFIX, formatValue, parseInput, toInput, type Unit } from './units'

export interface NumberSettingProps {
  label: string
  description?: ReactNode
  value: number
  unit: Unit
  /** Guarda el valor; devuelve el error para mostrar junto al campo, o null si salió. */
  onCommit: (value: number) => string | null
  /** Lo que se está escribiendo, ya interpretado (null si no es un número o no se edita). */
  onDraft?: (value: number | null) => void
  /** Un aviso calculado afuera mientras se escribe (la liquidación); se muestra como error. */
  warning?: string | null
  readOnly?: boolean
  /** El valor en sólo lectura, si no alcanza con el formato de la unidad. */
  readOnlyText?: string
  /** Lo que va debajo de la fila (la frase viva, la traducción). */
  children?: ReactNode
}

/**
 * Un ajuste numérico: fila con etiqueta y un campo compacto alineado a la derecha.
 * Mientras se escribe sólo cambia el borrador; se guarda al salir del campo o con
 * Enter, y Escape vuelve al valor guardado. Un error queda junto al campo, con el
 * texto escrito, hasta que se corrige.
 */
export function NumberSetting({
  label,
  description,
  value,
  unit,
  onCommit,
  onDraft,
  warning = null,
  readOnly = false,
  readOnlyText,
  children,
}: NumberSettingProps) {
  const inputId = useId()
  const noteId = `${inputId}-nota`
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (readOnly) {
    return <SettingRow label={label} description={description} control={<ReadValue>{readOnlyText ?? formatValue(value, unit)}</ReadValue>} />
  }

  const reset = () => {
    setDraft(null)
    setError(null)
    onDraft?.(null)
  }

  const commit = () => {
    if (draft === null) return
    const parsed = parseInput(draft, unit)
    if (parsed === null) return setError('Escribí un número.')
    if (parsed === value) return reset()
    const problem = onCommit(parsed)
    if (problem) return setError(problem)
    reset()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape' && draft !== null) {
      event.preventDefault()
      reset()
    }
  }

  const note = error ?? warning
  const { prefix, suffix } = AFFIX[unit]
  const below =
    children || note ? (
      <>
        {children}
        {note && (
          <p id={noteId} role="alert" className={clsx('text-sm text-loss text-pretty', children ? 'mt-2' : undefined)}>
            {glue(note)}
          </p>
        )}
      </>
    ) : undefined

  return (
    <SettingRow
      label={label}
      htmlFor={inputId}
      description={description}
      control={
        <div
          className={clsx(
            'flex h-11 w-24 items-center gap-1.5 rounded-control border bg-surface px-3 sm:w-[7.5rem]',
            'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink',
            note ? 'border-loss' : 'border-line',
          )}
        >
          {prefix && <span className="shrink-0 text-sm text-muted">{prefix}</span>}
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft ?? toInput(value, unit)}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
              onDraft?.(parseInput(event.target.value, unit))
            }}
            onBlur={commit}
            onKeyDown={onKeyDown}
            aria-invalid={note ? true : undefined}
            aria-describedby={note ? noteId : undefined}
            className="h-full w-full min-w-0 bg-transparent text-right text-[0.9375rem] tabular-nums outline-none"
          />
          {suffix && <span className="shrink-0 text-sm text-muted">{suffix}</span>}
        </div>
      }
    >
      {below}
    </SettingRow>
  )
}
