import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

export interface ScreenSkeletonProps {
  /** Qué se está cargando, para quien usa lector de pantalla ("Cargando posiciones"). */
  label: string
  /** La columna ancha (tablero, tablas) en vez de la de lectura. */
  wide?: boolean
  children: ReactNode
}

/**
 * Esqueleto de una pantalla con la misma geometría que va a tener (spec §11.4): el
 * cambio de pestaña se ve al instante y, cuando llegan los datos, nada salta.
 */
export function ScreenSkeleton({ label, wide = false, children }: ScreenSkeletonProps) {
  return (
    <div role="status" aria-busy="true" className={clsx(wide ? 'column-wide' : 'column', 'flex flex-col pt-6')}>
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  )
}

/** El titular de una pantalla: dos líneas del alto de `headline`, la segunda más corta. */
export function HeadlineSkeleton({ lines = 2 }: { lines?: 1 | 2 }) {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      <Skeleton className="h-7 w-full max-w-[34rem]" />
      {lines === 2 && <Skeleton className="h-7 w-2/3 max-w-[22rem]" />}
    </div>
  )
}

/** El título chico de una sección ("Abiertas ahora", "Tu capital"). */
export function SectionTitleSkeleton({ className }: { className?: string }) {
  return <Skeleton className={clsx('h-4 w-28', className)} />
}

/** Filas separadas por la línea de 1px, como las listas de la Libreta. */
export function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden className="border-b border-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-3 border-t border-line">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3.5 w-20 opacity-70" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
