import { Skeleton } from '@/components/ui/skeleton'
import { HeadlineSkeleton, ScreenSkeleton, SectionTitleSkeleton } from './screen-skeleton'

/** Filas de cada grupo de Ajustes (spec §11.1): capital, modo, riesgo, universo, bot y cuenta. */
const GROUPS = [3, 2, 4, 3, 3, 2] as const

/** Ajustes: grupos con título y un panel de filas etiqueta / control. */
export function AjustesSkeleton() {
  return (
    <ScreenSkeleton label="Cargando los ajustes">
      <HeadlineSkeleton lines={1} />
      {GROUPS.map((rows, group) => (
        <section key={group} aria-hidden className="mt-7 flex flex-col gap-2">
          <SectionTitleSkeleton className={group % 2 === 0 ? 'w-24' : 'w-16'} />
          <div className="panel px-4">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex h-14 items-center justify-between gap-4 border-line not-first:border-t">
                <Skeleton className={i % 2 === 0 ? 'h-4 w-2/5' : 'h-4 w-1/3'} />
                <Skeleton className="h-7 w-16 rounded-chip" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </ScreenSkeleton>
  )
}
