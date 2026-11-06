import clsx from 'clsx'
import type { Side } from '@sereno/core'
import { formatPrice } from './format'

export interface StopTpBarProps {
  side: Side
  entry: number
  stop: number
  takeProfit: number | null
  liquidation: number
  /** Marca vigente; null sin precio. */
  price: number | null
  /** Precio viejo (sin conexión): el punto va apagado. */
  stale?: boolean
  /** Sin los precios debajo (la columna de la tabla en desktop, donde están en otras columnas). */
  compact?: boolean
  className?: string
}

// Sin take profit (trailing puro) el extremo derecho es la entrada más 2R: alcanza
// para ver dónde está el precio respecto del stop sin inventar un objetivo.
const NO_TP_REACH_R = 2
// El punto puede pasarse un poco de los extremos para que se note que salió del tramo.
const OVERSHOOT = 0.04

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const pct = (f: number) => `${(f * 100).toFixed(2)}%`

/**
 * La barra stop ─●── TP de la spec §11.1 (Posiciones): el stop siempre a la izquierda
 * y el objetivo a la derecha, para long y para short; el tramo entre la entrada y el
 * precio pinta lo que va ganando o perdiendo, y la liquidación es una marca afuera
 * (casi siempre queda muy lejos: a escala no entraría).
 */
export function StopTpBar({ side, entry, stop, takeProfit, liquidation, price, stale = false, compact = false, className }: StopTpBarProps) {
  const far = takeProfit ?? entry + NO_TP_REACH_R * (entry - stop)
  const span = far - stop
  const at = (x: number) => (span === 0 ? 0 : (x - stop) / span)
  const entryAt = clamp(at(entry), 0, 1)
  const priceAt = price === null ? null : clamp(at(price), -OVERSHOOT, 1 + OVERSHOOT)
  const winning = price !== null && (side === 'long' ? price >= entry : price <= entry)

  const label = [
    `Stop ${formatPrice(stop)}`,
    price === null ? 'sin precio actual' : `precio ${formatPrice(price)}`,
    takeProfit === null ? 'sin take profit' : `take profit ${formatPrice(takeProfit)}`,
    `liquidación ${formatPrice(liquidation)}`,
  ].join(', ')

  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <div role="img" aria-label={label} className="relative h-3">
        {/* La liquidación, afuera del tramo y separada por un hueco. */}
        <span aria-hidden className="absolute top-0.5 left-1 h-2 w-0.5 rounded-chip bg-loss" />
        <div aria-hidden className="absolute inset-y-0 right-1 left-6">
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
          <span className="absolute top-0.5 left-0 h-2 w-px bg-muted" />
          <span className="absolute top-0.5 right-0 h-2 w-px bg-muted" />
          <span className="absolute top-0 h-3 w-px bg-ink/50" style={{ left: pct(entryAt) }} />
          {priceAt !== null && (
            <>
              <span
                className={clsx(
                  'absolute top-1/2 h-0.5 -translate-y-1/2 rounded-chip motion-safe:transition-[left,width] motion-safe:duration-300',
                  stale ? 'bg-muted' : winning ? 'bg-gain' : 'bg-loss',
                )}
                style={{ left: pct(Math.min(entryAt, priceAt)), width: pct(Math.abs(priceAt - entryAt)) }}
              />
              <span
                className={clsx(
                  'absolute top-1/2 size-2.5 -translate-1/2 rounded-full ring-2 ring-surface motion-safe:transition-[left] motion-safe:duration-300',
                  stale ? 'bg-muted' : 'bg-ink',
                )}
                style={{ left: pct(priceAt) }}
              />
            </>
          )}
        </div>
      </div>
      {!compact && (
        <div aria-hidden className="relative flex h-4 items-baseline justify-between text-xs leading-4 text-muted tabular-nums">
          <span className="text-loss">liq.</span>
          <span className="absolute left-6">stop {formatPrice(stop)}</span>
          <span>{takeProfit === null ? 'sin TP' : `TP ${formatPrice(takeProfit)}`}</span>
        </div>
      )}
    </div>
  )
}
