import type { ReactNode } from 'react'
import { sessionBase } from '@/components/nav/tabs'
import { AppShell } from '@/components/shell/app-shell'
import { getLive } from '@/lib/queries/books'
import { getActiveSessions, getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

// Las rutas raíz: la simulación en papel activa (o el primer uso, si todavía no hay ninguna).
// El layout no se vuelve a renderizar al cambiar de pestaña; cada página igual llama
// a `requireSession()` (cuesta nada: la sesión del pedido queda en caché), porque
// layout y página se renderizan en paralelo y la página no puede depender del layout.
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession()
  const [context, { real }] = await Promise.all([getContext(), getActiveSessions()])
  const live = context.session ? await getLive(context.session.id) : null
  return (
    <AppShell context={context} live={live} base="" switcher={{ paperHref: '', realHref: real ? sessionBase(real.id) : null, current: 'paper' }}>
      {children}
    </AppShell>
  )
}
