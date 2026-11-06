import { WEIGHT_MAX, WEIGHT_MIN } from '@sereno/core/src/learning/state'
import { formatNumber, formatPct, formatSigned } from '@/lib/format'
import type { SignalRow } from '@/lib/queries/aprendizaje'
import { signalLabel } from './labels'
import { Section } from './section'

export interface SignalsTableProps {
  signals: SignalRow[]
  /** Hubo pre-entrenamiento: la marca de cada peso es el del replay de origen, no 1,00. */
  fromReplay: boolean
}

const SIN_DATO = 'sin dato'

function reliabilityText(row: SignalRow): string {
  return row.reliability.rho === null ? SIN_DATO : formatSigned(row.reliability.rho, 2)
}

function hitText(row: SignalRow): string {
  return row.hitRate === null ? SIN_DATO : formatPct(row.hitRate, 0, false)
}

/** Posición de un peso en la pista [0,2 … 2,0], en %. */
function weightPct(w: number): number {
  return ((Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)) - WEIGHT_MIN) / (WEIGHT_MAX - WEIGHT_MIN)) * 100
}

/**
 * Señales (spec §8.1, §11.1.4): fiabilidad (Spearman contra el retorno a 4 h, 28 días),
 * acierto en trades y peso actual. El peso se dibuja como el tramo que recorrió desde
 * su punto de partida, así se ve de un vistazo qué subió y qué bajó.
 */
export function SignalsTable({ signals, fromReplay }: SignalsTableProps) {
  return (
    <Section
      title="Señales"
      description={`Fiabilidad: cuánto anticipa el precio a 4 horas en los últimos 28 días. Acierto: en cuántos trades votó para el lado que ganó. La marca del peso es ${
        fromReplay ? 'el del punto de partida' : 'el de fábrica (1,00)'
      }.`}
    >
      <table aria-label="Señales" className="w-full border-b border-line text-left">
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="pb-2 font-medium">
              Señal
            </th>
            <th scope="col" className="hidden w-28 pb-2 text-right font-medium desktop:table-cell">
              Fiabilidad
            </th>
            <th scope="col" className="hidden w-28 pb-2 text-right font-medium desktop:table-cell">
              Acierto
            </th>
            <th scope="col" className="w-[5.5rem] pb-2 pl-3 desktop:w-40">
              <span className="sr-only">Cambio del peso</span>
            </th>
            <th scope="col" className="w-12 pb-2 text-right font-medium">
              Peso
            </th>
          </tr>
        </thead>
        <tbody>
          {signals.map((row) => (
            <tr key={row.id} className="border-t border-line">
              <th scope="row" className="py-2.5 pr-3 font-normal">
                <span className="block font-medium">{signalLabel(row.id)}</span>
                <span className="block text-sm text-muted desktop:hidden">
                  fiabilidad {reliabilityText(row)} · acierto {hitText(row)}
                </span>
              </th>
              <td className="hidden py-2.5 text-right tabular-nums desktop:table-cell">
                <span className="block">{reliabilityText(row)}</span>
                <span className="block text-xs text-muted">n = {formatNumber(row.reliability.n, 0)}</span>
              </td>
              <td className="hidden py-2.5 text-right tabular-nums desktop:table-cell">
                <span className="block">{hitText(row)}</span>
                <span className="block text-xs text-muted">{row.hitTrades === 1 ? '1 trade' : `${formatNumber(row.hitTrades, 0)} trades`}</span>
              </td>
              <td className="py-2.5 pl-3">
                <WeightTrack weight={row.weight} start={row.startingWeight} />
              </td>
              <td className="py-2.5 text-right font-medium tabular-nums">{formatNumber(row.weight, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

/** La pista del peso: marca en el punto de partida, punto en el actual y el tramo entre los dos. */
function WeightTrack({ weight, start }: { weight: number; start: number }) {
  const from = weightPct(start)
  const to = weightPct(weight)
  return (
    <div aria-hidden className="relative h-3">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
      <span className="absolute top-0 h-3 w-px -translate-x-1/2 bg-muted" style={{ left: `${from}%` }} />
      <span className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-chip bg-ink" style={{ left: `${Math.min(from, to)}%`, width: `${Math.abs(to - from)}%` }} />
      <span className="absolute top-1/2 size-2 -translate-1/2 rounded-full bg-ink ring-2 ring-bg" style={{ left: `${to}%` }} />
    </div>
  )
}
