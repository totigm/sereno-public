import Link from 'next/link'
import type { SessionView } from '@/lib/queries/session'
import { contextBandLabel, replayStatusLabel } from './session-labels'

/**
 * Banda fija arriba de todo cuando se mira otra sesión (replay o simulación archivada).
 * Va en tinta invertida a propósito: es la única pieza del shell que tiene que
 * avisar, de un vistazo y en cualquier pantalla, que esto no es el presente. En
 * oscuro sería una franja blanca en la cara de noche: ahí pasa a superficie con línea.
 * Cuando está, es lo primero de la pantalla: su fondo cubre el área segura de arriba.
 */
export function ContextBand({ session }: { session: SessionView }) {
  const status = replayStatusLabel(session)
  return (
    <section aria-label="Contexto de la sesión" className="bg-ink pt-[env(safe-area-inset-top)] text-bg dark:border-b dark:border-line dark:bg-surface dark:text-ink">
      <div className="column-wide flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2 text-sm">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-medium">
          <span>{contextBandLabel(session)}</span>
          {status !== null && <span className="text-bg/65 dark:text-muted">{status}</span>}
        </p>
        <Link
          href="/"
          className="pressable inline-flex h-8 items-center rounded-chip bg-bg/12 px-3 font-semibold whitespace-nowrap hover:bg-bg/18 focus-visible:outline-bg dark:bg-ink/10 dark:hover:bg-ink/15 dark:focus-visible:outline-ink"
        >
          Volver a la simulación actual
        </Link>
      </div>
    </section>
  )
}
