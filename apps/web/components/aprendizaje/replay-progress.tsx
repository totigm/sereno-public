import clsx from 'clsx'

/** La barra de avance de un replay (`progreso` 0…1), con su valor para lectores de pantalla. */
export function ReplayProgress({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}%`}
      className={clsx('h-1.5 overflow-hidden rounded-chip bg-ink/8', className)}
    >
      <div
        className="h-full origin-left rounded-chip bg-ink transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  )
}
