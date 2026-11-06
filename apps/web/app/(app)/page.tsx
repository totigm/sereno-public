import type { Metadata } from 'next'
import { ResumenFirstRun } from '@/components/resumen/first-run'
import { ResumenPage } from '@/components/resumen/resumen-page'
import { getFirstRunData } from '@/lib/queries/resumen'
import { getContext } from '@/lib/queries/session'
import { requireSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Resumen' }

// La simulación activa; sin ninguna todavía, el formulario del primer uso.
export default async function ResumenRoute({ searchParams }: PageProps<'/'>) {
  await requireSession()
  const context = await getContext()
  const { session } = context
  if (!session) return <ResumenFirstRun data={await getFirstRunData()} />
  return <ResumenPage context={{ ...context, session }} searchParams={await searchParams} />
}
