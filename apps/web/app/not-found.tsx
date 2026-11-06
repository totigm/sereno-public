import type { Metadata } from 'next'
import Link from 'next/link'
import { BrandMark } from '@/components/brand-mark'
import { GapCurve } from '@/components/status/gap-curve'

export const metadata: Metadata = { title: 'No existe' }

// Una dirección que no lleva a nada, o una sesión que ya no está (`/s/<id>` con un id
// desconocido). Lo más probable es un enlace viejo a un replay o a una simulación
// archivada: por eso la segunda salida lleva a la lista de esas sesiones.
export default function NotFound() {
  return (
    <main className="column flex min-h-dvh flex-col pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <Link href="/" className="pressable flex w-fit items-center gap-2 rounded-control" aria-label="Sereno, ir al resumen">
        <BrandMark className="size-7 rounded-[6px]!" />
        <span className="font-semibold tracking-[-0.01em]">Sereno</span>
      </Link>

      <div className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div>
          <p aria-hidden className="text-[clamp(6.5rem,30vw,11rem)] leading-[0.82] font-semibold tracking-[-0.06em] text-ink">
            404
          </p>
          <GapCurve className="-mt-[clamp(0.5rem,3vw,1.25rem)] w-full max-w-[36rem]" />
        </div>

        <div className="flex max-w-[30rem] flex-col gap-2">
          <h1 className="headline">Esta página no existe.</h1>
          <p className="text-pretty text-muted">
            Puede que el enlace esté mal escrito o que sea de una sesión que ya no está. Lo demás sigue donde lo dejaste.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/" className="pressable inline-flex h-11 items-center rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg">
            Ir al resumen
          </Link>
          <Link
            href="/aprendizaje"
            className="pressable inline-flex h-11 items-center rounded-control border border-line bg-surface px-4 text-[0.9375rem] font-medium"
          >
            Ver replays y simulaciones
          </Link>
        </div>
      </div>
    </main>
  )
}
