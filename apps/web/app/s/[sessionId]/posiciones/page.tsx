import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PosicionesScreen } from '@/components/posiciones/posiciones-screen'
import { getPosicionesData, parsePosicionesQuery } from '@/lib/queries/posiciones'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Posiciones' }

// Las posiciones de un replay o de una simulación archivada (la activa también entra por acá si se pide por id).
export default async function SessionPosicionesPage({ params, searchParams }: PageProps<'/s/[sessionId]/posiciones'>) {
  await requireSession()
  const { sessionId } = await params
  const context = await getContext(sessionId)
  if (!context.session) notFound()
  const data = await getPosicionesData(sessionId, parsePosicionesQuery(await searchParams))
  if (!data) notFound()
  const { live: _live, ...screen } = data
  return <PosicionesScreen data={screen} context={context} />
}
