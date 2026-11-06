import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { FirstRunEmpty } from '@/components/monedas/board-empty'
import { coinParam } from '@/components/monedas/coin-param'
import { MonedasScreen } from '@/components/monedas/screen'
import { getMonedasData } from '@/lib/queries/monedas'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Monedas' }

// El tablero de la simulación activa; sin simulación, el vacío del primer uso.
export default async function MonedasPage({ searchParams }: PageProps<'/monedas'>) {
  await requireSession()
  const context = await getContext()
  if (!context.session) return <FirstRunEmpty />
  const data = await getMonedasData(context.session.id, coinParam(await searchParams))
  if (!data) notFound()
  return <MonedasScreen context={context} base="" coins={data.coins} excluded={data.excluded} detail={data.detail} theta={data.theta} />
}
