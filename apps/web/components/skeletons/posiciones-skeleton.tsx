import { Skeleton } from '@/components/ui/skeleton'
import { HeadlineSkeleton, ScreenSkeleton } from './screen-skeleton'

/** Una tarjeta de abierta del celu: tres líneas y la barra stop ─●── TP. */
function OpenCardSkeleton() {
  return (
    <div className="panel flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="h-3.5 w-3/4 opacity-70" />
      <Skeleton className="mt-1.5 h-1.5 w-full rounded-chip" />
    </div>
  )
}

const COLUMNS = 'grid grid-cols-[1.2fr_0.8fr_1fr_1fr_1fr_1fr] items-center gap-4'

/** Posiciones: segmento abiertas / cerradas / estadísticas; tarjetas en el celu, tabla en desktop. */
export function PosicionesSkeleton() {
  return (
    <ScreenSkeleton label="Cargando las posiciones" wide>
      <HeadlineSkeleton lines={1} />
      <Skeleton className="mt-5 h-9 w-full max-w-[22rem] rounded-control" />

      <div aria-hidden className="mt-5 flex flex-col gap-3 desktop:hidden">
        <OpenCardSkeleton />
        <OpenCardSkeleton />
        <OpenCardSkeleton />
      </div>

      <div aria-hidden className="panel mt-5 hidden px-4 desktop:block">
        <div className={`${COLUMNS} h-10`}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-3 w-14 opacity-60" />
          ))}
        </div>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className={`${COLUMNS} h-12 border-t border-line`}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-16 rounded-chip" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-1.5 w-full rounded-chip" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
    </ScreenSkeleton>
  )
}
