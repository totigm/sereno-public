import { Skeleton } from '@/components/ui/skeleton'
import { HeadlineSkeleton, ScreenSkeleton } from './screen-skeleton'

/** El universo por defecto (`universe.topN`): el tablero llega con 30 baldosas. */
const TILES = 30

/**
 * Monedas: el tablero a todo el ancho, con la grilla de la spec (3 columnas en el
 * celu, 2 bajo 360px, 5 en tablet, 6 en desktop) y baldosas de dos líneas con la
 * barra de inclinación abajo (en el celu, nombre y cambio en dos líneas).
 */
export function MonedasSkeleton() {
  return (
    <ScreenSkeleton label="Cargando el tablero" wide>
      <HeadlineSkeleton lines={1} />
      <Skeleton className="mt-3 h-4 w-56" />
      <div aria-hidden className="mt-5 grid grid-cols-3 gap-1.5 max-[359px]:grid-cols-2 min-[600px]:grid-cols-5 desktop:grid-cols-6 desktop:gap-2">
        {Array.from({ length: TILES }, (_, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-control border border-line bg-surface px-2.5 pt-2.5 pb-2">
            {/* Como la baldosa: en el celu el cambio va debajo del nombre. */}
            <div className="flex items-center justify-between gap-2 max-[599px]:flex-col max-[599px]:items-start max-[599px]:gap-1.5">
              <Skeleton className="h-3.5 w-10" />
              <Skeleton className="h-3 w-8 opacity-70" />
            </div>
            <Skeleton className="h-1 w-full rounded-chip opacity-70" />
          </div>
        ))}
      </div>
    </ScreenSkeleton>
  )
}
