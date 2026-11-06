import type { ReactNode } from 'react'
import { BottomBar } from '@/components/nav/bottom-bar'
import { ContextBand } from '@/components/nav/context-band'
import { MobileHeader } from '@/components/nav/mobile-header'
import type { SessionSwitcher } from '@/components/nav/session-switcher'
import { TopBar } from '@/components/nav/top-bar'
import { LiveProvider } from '@/lib/live/provider'
import type { LivePayload } from '@/lib/live/types'
import type { SessionContext } from '@/lib/queries/session'
import { LiveBands, TopBarStatus } from './live-status'

export interface AppShellProps {
  context: SessionContext
  /** El payload en vivo inicial; null sin sesión (primer uso). */
  live: LivePayload | null
  /** '' para la simulación activa, `/s/<id>` para otra sesión. */
  base: string
  /** El selector "Simulación" / "Plata real"; sin él (o sin sesión real activa), no aparece. */
  switcher?: SessionSwitcher
  children: ReactNode
}

/**
 * El marco de todas las pantallas (spec §11.1): cabecera con el nombre y el chip de la
 * sesión (con una sesión real activa, el selector de sesión en su lugar); banda de
 * contexto fuera de las sesiones activas, bandas de estado, y la navegación (abajo en el
 * celu, arriba en desktop).
 *
 * También pone la única consulta en vivo de la pantalla: las páginas leen
 * `useLiveContext()` en lugar de abrir otra. Sólo refresca en una sesión activa;
 * un replay o una simulación archivada muestran su estado final, quieto.
 */
export function AppShell({ context, live, base, switcher, children }: AppShellProps) {
  const { session, isActive } = context
  const showContext = session !== null && !isActive
  // Las bandas y el estado del bot sólo tienen sentido con el bot de esta sesión corriendo.
  const liveActive = live !== null && isActive

  const frame = (
    <>
      <a
        href="#contenido"
        className="sr-only z-50 rounded-control bg-ink px-4 py-2.5 text-sm font-medium text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Saltar al contenido
      </a>
      <header className="sticky top-0 z-30">
        {showContext && <ContextBand session={session} />}
        <TopBar
          base={base}
          session={session}
          belowBand={showContext}
          {...(liveActive ? { status: <TopBarStatus /> } : {})}
          {...(switcher ? { switcher } : {})}
        />
      </header>
      <MobileHeader base={base} session={session} belowBand={showContext} {...(switcher ? { switcher } : {})} />
      {liveActive && <LiveBands />}
      <main id="contenido" tabIndex={-1} className="pb-[calc(var(--shell-bottom)+2.5rem)] outline-none">
        {children}
      </main>
      <BottomBar base={base} />
    </>
  )

  if (live === null || session === null) return frame
  return (
    <LiveProvider sessionId={session.id} initial={live} enabled={isActive}>
      {frame}
    </LiveProvider>
  )
}
