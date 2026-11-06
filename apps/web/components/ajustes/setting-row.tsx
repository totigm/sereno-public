import clsx from 'clsx'
import { useId, type ReactNode } from 'react'
import { glue } from './glue'

// Los bloques de la pantalla, con la geometría de su esqueleto: un título chico, un
// panel y filas etiqueta / control separadas por la línea de 1px (como las listas de
// la Libreta).

export function SettingsSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-9 flex flex-col gap-2.5">
      <h2 id={id} className="text-[0.9375rem] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('panel', className)}>{children}</div>
}

/** El marco de una fila: padding y la línea de arriba (salvo en la primera). */
export function RowFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('border-line px-4 py-3 not-first:border-t', className)}>{children}</div>
}

export interface SettingRowProps {
  label: ReactNode
  /** El `id` del control que nombra la etiqueta (campos); sin él, la etiqueta es texto. */
  htmlFor?: string
  labelId?: string
  description?: ReactNode
  /** El control o, en sólo lectura, el valor. */
  control?: ReactNode
  /** Lo que va debajo, a todo el ancho: la frase viva, la traducción, un error. */
  children?: ReactNode
  /** Controles anchos (segmentos) que en el celu bajan debajo de la etiqueta. */
  wrap?: boolean
}

export function SettingRow({ label, htmlFor, labelId, description, control, children, wrap = false }: SettingRowProps) {
  const Label = htmlFor ? 'label' : 'span'
  return (
    <RowFrame>
      <div className={clsx('flex min-h-11 items-center justify-between gap-x-4 gap-y-2.5', wrap && 'flex-wrap')}>
        <div className={clsx('min-w-0 flex-1', wrap && 'basis-56')}>
          <Label id={labelId} {...(htmlFor ? { htmlFor } : {})} className="block font-medium">
            {label}
          </Label>
          {description && <div className="text-sm text-muted text-pretty">{glue(description)}</div>}
        </div>
        {control !== undefined && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </RowFrame>
  )
}

/** El valor de un ajuste en sólo lectura, alineado como lo estaría el control. */
export function ReadValue({ children }: { children: ReactNode }) {
  return <span className="text-[0.9375rem] font-medium tabular-nums">{children}</span>
}
