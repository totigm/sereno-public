import { notFound } from 'next/navigation'
import { getAprendizajeData, getLearningLogPage } from '@/lib/queries/aprendizaje'
import type { SessionContext, SessionView } from '@/lib/queries/session'
import { AprendizajeScreen } from './aprendizaje-screen'
import { parseJournalCursor } from './journal-cursor'

export interface AprendizajePageProps {
  context: SessionContext & { session: SessionView }
  searchParams: Record<string, string | string[] | undefined>
}

/**
 * Lo que comparten las dos rutas de Aprendizaje una vez resuelto el contexto: los datos
 * de la sesión y, si la URL pide una página anterior del diario, esa página.
 */
export async function AprendizajePage({ context, searchParams }: AprendizajePageProps) {
  const { id } = context.session
  const cursor = parseJournalCursor(searchParams)
  const [data, olderLog] = await Promise.all([getAprendizajeData(id), cursor ? getLearningLogPage(id, cursor) : null])
  if (!data) notFound()
  return <AprendizajeScreen data={data} context={context} olderLog={olderLog} />
}
