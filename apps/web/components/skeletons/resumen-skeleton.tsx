import { Skeleton, SkeletonLines } from '@/components/ui/skeleton'
import { HeadlineSkeleton, RowsSkeleton, ScreenSkeleton, SectionTitleSkeleton } from './screen-skeleton'

/** Resumen: titular, línea secundaria y veredicto, curva con rangos, abiertas y capital (lado a lado en desktop) y diario. */
export function ResumenSkeleton() {
  return (
    <ScreenSkeleton label="Cargando el resumen">
      <HeadlineSkeleton />
      <Skeleton className="mt-3 h-4 w-11/12 max-w-[30rem]" />
      <Skeleton className="mt-2 h-4 w-3/5 max-w-[24rem]" />

      <div aria-hidden className="panel mt-5 flex flex-col gap-3 p-3">
        <div className="flex gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7 w-14 rounded-chip" />
          ))}
        </div>
        <Skeleton className="h-[180px] w-full desktop:h-[220px]" />
      </div>

      <div className="mt-7 grid gap-7 desktop:grid-cols-[1.3fr_1fr] desktop:gap-5">
        <section aria-hidden className="flex flex-col gap-2">
          <SectionTitleSkeleton />
          <RowsSkeleton rows={3} />
        </section>
        <section aria-hidden className="flex flex-col gap-2">
          <SectionTitleSkeleton className="w-20" />
          <div className="panel flex flex-col gap-3 p-4">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-2 w-full rounded-chip" />
            <Skeleton className="h-3.5 w-11/12 opacity-70" />
          </div>
        </section>
      </div>

      <section aria-hidden className="mt-7 flex flex-col gap-3">
        <SectionTitleSkeleton className="w-36" />
        <Skeleton className="h-4 w-4/5" />
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-4 w-10 shrink-0" />
              <SkeletonLines lines={i % 2 === 0 ? 2 : 1} className="flex-1" />
            </div>
          ))}
        </div>
      </section>

      <div aria-hidden className="mt-7 flex flex-wrap gap-1.5">
        <Skeleton className="h-6 w-44 rounded-chip" />
        <Skeleton className="h-6 w-32 rounded-chip" />
      </div>
    </ScreenSkeleton>
  )
}
