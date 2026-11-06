import clsx from 'clsx'
import type { Side, SignalId } from '@sereno/core'
import { WEIGHT_MAX } from '@sereno/core/src/learning/state'
import { SIGNAL_NAMES } from '@sereno/core/src/journal/reasons'
import { formatNumber, formatSigned } from '@/lib/format'

export interface TradeSignal {
  id: SignalId
  /** −1 (short) … +1 (long); null si la señal no tenía dato al abrir. */
  value: number | null
  /** Peso efectivo vigente de la moneda; null mientras llega del servidor. */
  weight: number | null
}

/** "Tendencia de 15 minutos", "Régimen de BTC": el nombre del diario sin el artículo. */
export function signalLabel(id: SignalId): string {
  const name = SIGNAL_NAMES[id].replace(/^(?:la|el|las|los) /, '')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// En el celu el nombre va arriba y las dos barras abajo; en desktop, todo en una fila.
const ROW = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-x-4 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_6rem] desktop:gap-x-3'

const pct = (f: number) => `${(Math.min(1, Math.max(0, f)) * 100).toFixed(1)}%`

/** Barra que sale del centro: a la derecha empuja al long, a la izquierda al short. */
function ValueBar({ value, side }: { value: number; side: Side }) {
  const inFavor = side === 'long' ? value > 0 : value < 0
  const size = Math.min(1, Math.abs(value)) / 2
  return (
    <span aria-hidden className="relative h-1.5 flex-1 rounded-chip bg-ink/6">
      <span className="absolute inset-y-[-3px] left-1/2 w-px bg-muted/60" />
      <span
        className={clsx('absolute inset-y-0 rounded-chip', inFavor ? 'bg-gain' : 'bg-loss')}
        style={value >= 0 ? { left: '50%', width: pct(size) } : { right: '50%', width: pct(size) }}
      />
    </span>
  )
}

function WeightBar({ weight }: { weight: number }) {
  return (
    <span aria-hidden className="relative h-1.5 w-full rounded-chip bg-ink/6">
      <span className="absolute inset-y-0 left-0 rounded-chip bg-ink/55" style={{ width: pct(weight / WEIGHT_MAX) }} />
    </span>
  )
}

/**
 * Las señales al abrir (spec §11.1): el valor de cada una, a favor o en contra del lado
 * del trade, y su peso. Los pesos de aquel momento no se guardan: va el de hoy.
 */
export function TradeSignals({ signals, side }: { signals: TradeSignal[]; side: Side }) {
  if (signals.length === 0) return <p className="text-sm text-muted">No quedaron registradas las señales de esta apertura.</p>
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden className={clsx(ROW, 'text-xs text-muted')}>
        <span className="hidden desktop:block" />
        {/* Sobre la barra sola: el número de al lado (w-10 + gap-2) queda afuera. */}
        <span className="flex justify-between pr-12">
          <span>short</span>
          <span>valor al abrir</span>
          <span>long</span>
        </span>
        <span className="whitespace-nowrap">peso de hoy</span>
      </div>
      <ul className="flex flex-col">
        {signals.map((s) => {
          const label = signalLabel(s.id)
          const valueText = s.value === null ? 'sin dato' : formatSigned(s.value, 2)
          const favor = s.value === null || s.value === 0 ? '' : (side === 'long') === s.value > 0 ? ', a favor' : ', en contra'
          const weightText = s.weight === null ? '' : `, peso ${formatNumber(s.weight, 2)}`
          return (
            <li
              key={s.id}
              aria-label={`${label}: ${valueText}${favor}${weightText}`}
              className={clsx(ROW, 'items-center gap-y-1 py-1.5 text-sm desktop:min-h-9 desktop:py-0')}
            >
              <span className="col-span-2 truncate desktop:col-span-1">{label}</span>
              <span className="flex items-center gap-2">
                {s.value === null ? <span className="flex-1 text-xs text-muted">sin dato</span> : <ValueBar value={s.value} side={side} />}
                <span className="w-10 text-right text-xs text-muted tabular-nums">{s.value === null ? '' : formatSigned(s.value, 2)}</span>
              </span>
              <span className="flex items-center gap-2">
                {s.weight === null ? (
                  <span className="h-1.5 w-full rounded-chip bg-ink/6 motion-safe:animate-pulse" />
                ) : (
                  <WeightBar weight={s.weight} />
                )}
                <span className="w-8 text-right text-xs text-muted tabular-nums">{s.weight === null ? '' : formatNumber(s.weight, 1)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
