import clsx from 'clsx'
import type { SignalId, SignalResult } from '@sereno/core'
import { SIGNAL_NAMES } from '@sereno/core/src/journal/phrases'
import { formatNumber, formatSigned } from '@/lib/format'

export interface SignalBarsProps {
  signals: readonly SignalResult[]
  /** Peso efectivo de cada señal en esta moneda (spec §8). */
  weights: Readonly<Record<SignalId, number>>
  /** Id del título que nombra la tabla. */
  labelledBy: string
}

/** "la tendencia de 15 minutos" → "Tendencia de 15 minutos": el nombre del diario como etiqueta. */
function signalLabel(id: SignalId): string {
  const name = SIGNAL_NAMES[id].replace(/^(?:el|la|los|las) /, '')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

// Primero las que más empujaron el puntaje (|peso × valor|); las que no tuvieron dato, al final.
function byWeight(weights: SignalBarsProps['weights']) {
  const pull = (s: SignalResult) => (s.value === null ? -1 : Math.abs(s.value * (weights[s.id] ?? 0)))
  return (a: SignalResult, b: SignalResult) => pull(b) - pull(a)
}

/**
 * El puntaje desglosado por señal (spec §11.1): una tabla cuyas filas llevan la barra
 * de cada valor, de −1 (short, a la izquierda) a +1 (long, a la derecha). La tabla
 * es a la vez el gráfico y su versión legible: valor y peso van siempre en texto.
 */
export function SignalBars({ signals, weights, labelledBy }: SignalBarsProps) {
  const rows = [...signals].sort(byWeight(weights))
  return (
    <table aria-labelledby={labelledBy} className="w-full table-fixed border-collapse text-sm">
      <colgroup>
        <col />
        <col className="w-[34%]" />
        <col className="w-14" />
        <col className="w-10" />
      </colgroup>
      <thead>
        <tr className="text-xs text-muted">
          <th scope="col" className="pb-1.5 text-left font-medium">
            Señal
          </th>
          <th scope="col" className="pb-1.5 font-medium">
            <span className="sr-only">Barra</span>
          </th>
          <th scope="col" className="pb-1.5 text-right font-medium">
            Valor
          </th>
          <th scope="col" className="pb-1.5 text-right font-medium">
            Peso
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id} className="border-t border-line">
            <th scope="row" className="truncate py-2 pr-3 text-left font-normal">
              {signalLabel(s.id)}
            </th>
            <td className="py-2">
              <SignalBar value={s.value} />
            </td>
            <td className={clsx('py-2 text-right tabular-nums', s.value === null && 'text-muted')}>
              {s.value === null ? 'sin dato' : formatSigned(s.value, 2)}
            </td>
            <td className="py-2 text-right text-muted tabular-nums">{formatNumber(weights[s.id] ?? 0, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Una barra divergente desde el centro: verde hacia long, roja hacia short. */
function SignalBar({ value }: { value: number | null }) {
  const v = value === null ? 0 : Math.max(-1, Math.min(1, value))
  const half = Math.abs(v) * 50
  return (
    <span aria-hidden className="relative block h-1.5 w-full rounded-chip bg-line">
      {value !== null && half > 0 && (
        <span
          style={{ left: `${v < 0 ? 50 - half : 50}%`, width: `${half}%` }}
          className={clsx('absolute inset-y-0', v < 0 ? 'rounded-l-chip bg-loss' : 'rounded-r-chip bg-gain')}
        />
      )}
      <span className="absolute -top-0.5 left-1/2 h-2.5 w-px -translate-x-1/2 bg-muted/70" />
    </span>
  )
}
