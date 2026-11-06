import clsx from 'clsx'

export type SkeletonProps = {
  className?: string
}

/** Bloque gris con la geometría de lo que va a aparecer; late sólo si el sistema permite movimiento. */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={clsx('rounded-[8px] bg-ink/8 motion-safe:animate-pulse', className)} />
}

const lineWidths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3']

/** Varias líneas de texto, con anchos que no parecen una tabla. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx('h-4', lineWidths[i % lineWidths.length])} />
      ))}
    </div>
  )
}
