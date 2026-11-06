import Link from 'next/link'

/** Posiciones antes de crear la primera simulación (spec §11.1, primer uso). */
export function PosicionesFirstRun() {
  return (
    <div className="column-wide flex flex-col items-start gap-3 pt-6">
      <h1 className="headline">Acá van a aparecer las operaciones cerradas.</h1>
      <p className="max-w-[36rem] text-pretty text-muted">
        Primero hay que crear la simulación: se arma en el resumen, en dos pasos. Cuando el bot abra y cierre operaciones, las
        vas a ver acá con su gráfico, sus señales y sus costos.
      </p>
      <Link
        href="/"
        className="pressable mt-2 inline-flex h-11 items-center rounded-control bg-ink px-4 text-[0.9375rem] font-medium text-bg"
      >
        Ir al resumen
      </Link>
    </div>
  )
}
