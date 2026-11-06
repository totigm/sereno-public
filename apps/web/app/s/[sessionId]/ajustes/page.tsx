import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AjustesScreen } from '@/components/ajustes/ajustes-screen'
import { getAjustesData } from '@/lib/queries/ajustes'
import { getRealPanel } from '@/lib/queries/real'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Ajustes' }

// Otra sesión: la de plata real (con Ajustes › Plata real arriba), o un replay o una
// simulación archivada, de sólo lectura. Una activa por su id se edita igual.
export default async function SessionAjustesPage({ params }: PageProps<'/s/[sessionId]/ajustes'>) {
  const { user } = await requireSession()
  const { sessionId } = await params
  const context = await getContext(sessionId)
  if (!context.session) notFound()
  const [data, real] = await Promise.all([getAjustesData(sessionId), context.isActive ? getRealPanel() : null])
  if (!data) notFound()
  const { session, settings, defaults, universe, shieldedAt, accountTiers } = data
  return <AjustesScreen data={{ session, settings, defaults, universe, shieldedAt, accountTiers, real }} readOnly={!context.isActive} email={user.email} />
}
