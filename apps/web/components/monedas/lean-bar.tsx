import clsx from 'clsx'

export interface LeanBarProps {
  /** S′ del último ciclo, de −1 (short) a +1 (long); null si la moneda no tiene puntaje. */
  sPrime: number | null
  /** Umbral de entrada: desde |S′| ≥ θ la barra va con el color pleno. */
  theta: number
  className?: string
}

const pct = (n: number): string => `${Math.round(n * 100) / 100}%`

/**
 * La barra de inclinación de la baldosa (spec §11.1): el centro es neutral, crece hacia
 * la derecha si se inclina a long y hacia la izquierda si a short, con la mitad del
 * ancho para |S′| = 1. Por debajo del umbral va tenue: se inclina, pero no alcanza
 * para entrar. Se anima al cambiar; con movimiento reducido cambia de golpe.
 */
export function LeanBar({ sPrime, theta, className }: LeanBarProps) {
  const lean = sPrime === null ? null : Math.max(-1, Math.min(1, sPrime))
  const half = lean === null ? 0 : Math.abs(lean) * 50
  return (
    <span aria-hidden className={clsx('relative block h-1 w-full rounded-chip bg-line', className)}>
      {lean !== null && (
        <span
          data-lean-fill
          style={{ left: pct(lean < 0 ? 50 - half : 50), width: pct(half) }}
          className={clsx(
            'absolute inset-y-0 transition-[left,width,opacity] duration-500 ease-out motion-reduce:transition-none',
            // El extremo del dato redondeado; el del centro, recto.
            lean < 0 ? 'rounded-l-chip bg-loss' : 'rounded-r-chip bg-gain',
            Math.abs(lean) < theta && 'opacity-45',
          )}
        />
      )}
      <span className="absolute -top-0.5 left-1/2 h-2 w-px -translate-x-1/2 bg-muted/70" />
    </span>
  )
}
