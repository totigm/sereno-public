import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { coinParam } from '@/components/monedas/coin-param'
import { MonedasScreen } from '@/components/monedas/screen'
import { sessionBase } from '@/components/nav/tabs'
import { getMonedasData } from '@/lib/queries/monedas'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Monedas' }

// El tablero de otra sesión (replay o simulación archivada): cómo quedó al final.
export default async function SessionMonedasPage({ params, searchParams }: PageProps<'/s/[sessionId]/monedas'>) {
  await requireSession()
  const { sessionId } = await params
  const context = await getContext(sessionId)
  if (!context.session) notFound()
  const data = await getMonedasData(sessionId, coinParam(await searchParams))
  if (!data) notFound()
  return (
    <MonedasScreen
      context={context}
      base={sessionBase(sessionId)}
      coins={data.coins}
      excluded={data.excluded}
      detail={data.detail}
      theta={data.theta}
    />
  )
}
