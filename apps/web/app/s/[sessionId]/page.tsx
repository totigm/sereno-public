import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ResumenPage } from '@/components/resumen/resumen-page'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Resumen' }

// Un replay o una simulación archivada (o la activa, si se llegó por su id).
export default async function SessionResumenRoute({ params, searchParams }: PageProps<'/s/[sessionId]'>) {
  await requireSession()
  const { sessionId } = await params
  const context = await getContext(sessionId)
  const { session } = context
  if (!session) notFound()
  return <ResumenPage context={{ ...context, session }} searchParams={await searchParams} />
}
