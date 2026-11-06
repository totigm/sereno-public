import { notFound } from 'next/navigation'
import { ReplayState } from '@/components/aprendizaje/replay-report'
import { getResumenData, parseResumenQuery } from '@/lib/queries/resumen'
import type { SessionContext, SessionView } from '@/lib/queries/session'
import { ResumenScreen } from './resumen-screen'

export interface ResumenPageProps {
  context: SessionContext & { session: SessionView }
  searchParams: Record<string, string | string[] | undefined>
}

/**
 * Lo que comparten las dos rutas de Resumen una vez resuelto el contexto. Un replay que
 * todavía corre (o que no terminó) no tiene resultado: muestra en qué está.
 */
export async function ResumenPage({ context, searchParams }: ResumenPageProps) {
  const { session } = context
  if (session.kind === 'replay' && session.status !== 'listo') {
    return (
      <div className="column pt-6">
        <ReplayState session={session} whenDone="Cuando termine, acá vas a ver cuánto hubiera ganado o perdido." />
      </div>
    )
  }
  const data = await getResumenData(session.id, parseResumenQuery(searchParams))
  if (!data) notFound()
  const { live: _live, ...screen } = data
  return <ResumenScreen data={screen} context={context} />
}
