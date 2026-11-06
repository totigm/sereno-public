import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AprendizajePage } from '@/components/aprendizaje/aprendizaje-page'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Aprendizaje' }

// Un replay o una simulación archivada (o la activa, si se llegó por su id).
export default async function SessionAprendizajeRoute({ params, searchParams }: PageProps<'/s/[sessionId]/aprendizaje'>) {
  await requireSession()
  const { sessionId } = await params
  const context = await getContext(sessionId)
  const { session } = context
  if (!session) notFound()
  return <AprendizajePage context={{ ...context, session }} searchParams={await searchParams} />
}
