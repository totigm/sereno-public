import clsx from 'clsx'
import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & {
  label: string
  /** Aclaración debajo del campo; si hay `error`, lo reemplaza. */
  hint?: ReactNode
  error?: ReactNode
  /** Unidad pegada al valor, por ejemplo "US$" o "%". */
  prefix?: ReactNode
  suffix?: ReactNode
}

export function Field({ label, hint, error, prefix, suffix, id, className, ...input }: FieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const noteId = `${inputId}-note`
  const note = error ?? hint

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div
        className={clsx(
          'flex h-11 items-center gap-2 rounded-control border bg-surface px-3',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink',
          error ? 'border-loss' : 'border-line',
        )}
      >
        {prefix && <span className="shrink-0 text-muted">{prefix}</span>}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          {...input}
        />
        {suffix && <span className="shrink-0 text-muted">{suffix}</span>}
      </div>
      {note && (
        <p id={noteId} className={clsx('text-sm', error ? 'text-loss' : 'text-muted')}>
          {note}
        </p>
      )}
    </div>
  )
}
