import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { SessionSwitcher } from '@/components/nav/session-switcher'
import { sessionBase } from '@/components/nav/tabs'
import { AppShell } from '@/components/shell/app-shell'
import { getLive } from '@/lib/queries/books'
import { getActiveSessions, getContext, getSessionView, type SessionView } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

// La sesión con plata real se marca también en la pestaña del navegador (spec real
// §Dashboard): "Plata real · Sereno" y "Ajustes · Plata real · Sereno". Es `absolute`
// porque un `default` pasaría además por el molde de la raíz ("… · Sereno · Sereno").
export async function generateMetadata({ params }: LayoutProps<'/s/[sessionId]'>): Promise<Metadata> {
  const { sessionId } = await params
  const session = await getSessionView(sessionId)
  if (session?.kind !== 'live') return {}
  return { title: { absolute: 'Plata real · Sereno', template: '%s · Plata real · Sereno' } }
}

function switcherFor(session: SessionView, active: { paper: SessionView | null; real: SessionView | null }): SessionSwitcher {
  const current = session.id === active.real?.id ? 'real' : session.id === active.paper?.id ? 'paper' : 'other'
  return { paperHref: '', realHref: active.real ? sessionBase(active.real.id) : null, current }
}

// Cualquier sesión que no sea la simulación en papel activa (la de plata real, un replay
// o una archivada), con los mismos cinco destinos pegados a ella (spec §11.1). Un id que
// no existe es un 404.
export default async function SessionLayout({ children, params }: LayoutProps<'/s/[sessionId]'>) {
  await requireSession()
  const { sessionId } = await params
  const [context, active] = await Promise.all([getContext(sessionId), getActiveSessions()])
  if (!context.session) notFound()
  const live = await getLive(sessionId)
  return (
    <AppShell context={context} live={live} base={sessionBase(sessionId)} switcher={switcherFor(context.session, active)}>
      {children}
    </AppShell>
  )
}
