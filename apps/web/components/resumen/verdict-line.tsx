import clsx from 'clsx'
import Link from 'next/link'
import type { VerdictView } from '@/lib/queries/stats'

export interface VerdictLineProps {
  verdict: Pick<VerdictView, 'reason'>
  /** La tarjeta de veredicto completa (Posiciones › Estadísticas), con las cuatro condiciones. */
  href: string
  className?: string | undefined
}

/**
 * El veredicto en una línea (spec §11.1, criterio en §11.6): "Con 23 operaciones todavía no
 * se puede saber si tiene ventaja; faltan 77." Lleva a la tarjeta completa con el detalle.
 */
export function VerdictLine({ verdict, href, className }: VerdictLineProps) {
  return (
    <p className={clsx('text-[0.9375rem] text-pretty text-muted', className)}>
      <Link href={href} className="rounded-[4px] decoration-line underline-offset-4 hover:text-ink hover:underline">
        {verdict.reason}
      </Link>
    </p>
  )
}
