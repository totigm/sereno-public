import clsx from 'clsx'
import { useId, type ReactNode } from 'react'

export interface SectionProps {
  title: string
  /** Acción del encabezado ("Ver todo"), alineada a la derecha. */
  action?: ReactNode
  className?: string | undefined
  children: ReactNode
}

/** Una sección de Resumen con su título chico, como en la Libreta ("Abiertas ahora", "Tu capital"). */
export function Section({ title, action, className, children }: SectionProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className={clsx('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-h-6 items-center justify-between gap-4">
        <h2 id={titleId} className="text-[0.9375rem] leading-snug font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}
