import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PosicionesFirstRun } from '@/components/posiciones/first-run'
import { PosicionesScreen } from '@/components/posiciones/posiciones-screen'
import { getPosicionesData, parsePosicionesQuery } from '@/lib/queries/posiciones'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Posiciones' }

// La simulación activa; sin ninguna todavía, el vacío del primer uso.
export default async function PosicionesPage({ searchParams }: PageProps<'/posiciones'>) {
  await requireSession()
  const context = await getContext()
  if (!context.session) return <PosicionesFirstRun />
  const data = await getPosicionesData(context.session.id, parsePosicionesQuery(await searchParams))
  if (!data) notFound()
  const { live: _live, ...screen } = data
  return <PosicionesScreen data={screen} context={context} />
}
