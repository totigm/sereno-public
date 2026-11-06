import clsx from 'clsx'
import { useId, type ReactNode } from 'react'

export interface SectionProps {
  title: string
  /** Una línea que dice cómo leer lo que sigue. */
  description?: ReactNode
  /** Acción del encabezado ("Ver todo el diario"), alineada a la derecha. */
  action?: ReactNode
  className?: string
  children: ReactNode
}

/** Una sección de la pantalla con su título chico, como las de la Libreta ("Abiertas ahora"). */
export function Section({ title, description, action, className, children }: SectionProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className={clsx('mt-9 flex flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[0.9375rem] leading-snug font-semibold">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-pretty text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
