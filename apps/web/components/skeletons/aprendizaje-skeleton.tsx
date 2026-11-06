import { Skeleton, SkeletonLines } from '@/components/ui/skeleton'
import { HeadlineSkeleton, ScreenSkeleton, SectionTitleSkeleton } from './screen-skeleton'

/** Aprendizaje: qué cambió, originales contra aprendidos (dos curvas), señales y replays. */
export function AprendizajeSkeleton() {
  return (
    <ScreenSkeleton label="Cargando el aprendizaje">
      <HeadlineSkeleton />

      <section aria-hidden className="mt-7 flex flex-col gap-3">
        <SectionTitleSkeleton />
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-4 w-10 shrink-0" />
              <SkeletonLines lines={2} className="flex-1" />
            </div>
          ))}
        </div>
      </section>

      <section aria-hidden className="mt-7 flex flex-col gap-3">
        <SectionTitleSkeleton className="w-48" />
        <div className="panel flex flex-col gap-3 p-3">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-[160px] w-full desktop:h-[200px]" />
        </div>
      </section>

      <section aria-hidden className="mt-7 flex flex-col gap-2">
        <SectionTitleSkeleton className="w-20" />
        <div className="border-b border-line">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="grid h-12 grid-cols-[6rem_1fr_3rem] items-center gap-3 border-t border-line">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-1.5 w-full rounded-chip opacity-70" />
              <Skeleton className="ml-auto h-4 w-10" />
            </div>
          ))}
        </div>
      </section>

      <section aria-hidden className="mt-7 flex flex-col gap-2">
        <SectionTitleSkeleton className="w-40" />
        <div className="panel flex items-center justify-between gap-3 p-4">
          <SkeletonLines lines={2} className="flex-1" />
          <Skeleton className="h-9 w-32 rounded-control" />
        </div>
      </section>
    </ScreenSkeleton>
  )
}
