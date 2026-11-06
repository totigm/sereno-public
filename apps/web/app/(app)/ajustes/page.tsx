import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AjustesEmpty } from '@/components/ajustes/ajustes-empty'
import { AjustesScreen } from '@/components/ajustes/ajustes-screen'
import { getAjustesData } from '@/lib/queries/ajustes'
import { getRealPanel } from '@/lib/queries/real'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Ajustes' }

// La simulación activa; sin ninguna (primer uso), sólo la cuenta.
export default async function AjustesPage() {
  const { user } = await requireSession()
  const context = await getContext()
  if (!context.session) return <AjustesEmpty email={user.email} />
  const [data, real] = await Promise.all([getAjustesData(context.session.id), context.isActive ? getRealPanel() : null])
  if (!data) notFound()
  const { session, settings, defaults, universe, shieldedAt, accountTiers } = data
  return <AjustesScreen data={{ session, settings, defaults, universe, shieldedAt, accountTiers, real }} readOnly={!context.isActive} email={user.email} />
}
