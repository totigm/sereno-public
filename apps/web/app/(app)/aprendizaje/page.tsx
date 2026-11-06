import type { Metadata } from 'next'
import { AprendizajePage } from '@/components/aprendizaje/aprendizaje-page'
import { AprendizajeFirstRun } from '@/components/aprendizaje/first-run'
import { getSessionSummaries } from '@/lib/queries/aprendizaje'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Aprendizaje' }

// La simulación activa; sin ninguna todavía, el vacío del primer uso.
export default async function AprendizajeRoute({ searchParams }: PageProps<'/aprendizaje'>) {
  await requireSession()
  const context = await getContext()
  const { session } = context
  if (!session) {
    const now = Date.now()
    return <AprendizajeFirstRun sessions={await getSessionSummaries(null, now)} now={now} />
  }
  return <AprendizajePage context={{ ...context, session }} searchParams={await searchParams} />
}
