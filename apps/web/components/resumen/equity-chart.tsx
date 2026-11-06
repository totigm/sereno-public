'use client'

import clsx from 'clsx'
import { motion } from 'motion/react'
import { useId, useMemo, useState } from 'react'
import { shortDate } from '@/components/aprendizaje/labels'
import { EquityChart } from '@/components/charts/equity-chart'
import { SERIES_STROKE, type OptionalSeries } from '@/components/charts/series-style'
import { Segment } from '@/components/ui/segment'
import { formatTimeBA, formatUsd } from '@/lib/format'
import { fade } from '@/lib/motion'
import type { EquityRange } from '@/lib/queries/equity-curve'
import { EQUITY_GAP_MS } from '@/lib/queries/equity-gap'
import type { ResumenData } from '@/lib/queries/resumen'
import { rangeTone, valueRows, withLivePoint, type LivePoint } from './equity-series'

export interface EquitySectionProps {
  equity: ResumenData['equity']
  /** El punto de ahora (simulación activa con el bot conectado), o null. Estable mientras no cambie. */
  livePoint: LivePoint | null
  /** Replay o archivada: "Último día" en lugar de "Hoy" y sin hueco al final. */
  past: boolean
  /** Reloj para las fechas cortas (el año aparece sólo si no es el de ahora). */
  now: number
}

const RANGE_LABELS: Record<EquityRange, string> = { hoy: 'Hoy', '7d': '7 días', '30d': '30 días', todo: 'Todo' }
const RANGE_NAMES: Record<EquityRange, string> = { hoy: 'de hoy', '7d': 'de los últimos 7 días', '30d': 'de los últimos 30 días', todo: 'de toda la simulación' }

/** La muestra del botón: 12 × 2 px con el mismo trazo que la línea del gráfico. */
function Swatch({ series, pressed }: { series: OptionalSeries; pressed: boolean }) {
  return (
    <svg aria-hidden data-swatch={series} width={12} height={2} viewBox="0 0 12 2" className={clsx('shrink-0 overflow-visible', !pressed && 'opacity-50')}>
      <line x1={0} y1={1} x2={12} y2={1} {...SERIES_STROKE[series]} strokeWidth={2} strokeLinecap="butt" />
    </svg>
  )
}

function SeriesToggle({ pressed, onToggle, series, children }: { pressed: boolean; onToggle: () => void; series: OptionalSeries; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className="pressable group -my-1.5 inline-flex min-h-11 items-center"
    >
      <span
        className={clsx(
          'inline-flex h-7 items-center gap-1.5 rounded-chip border px-2.5 text-xs font-medium transition-colors duration-150',
          pressed ? 'border-line bg-surface text-ink' : 'border-transparent bg-ink/6 text-muted group-hover:text-ink',
        )}
      >
        <Swatch series={series} pressed={pressed} />
        {children}
      </span>
    </button>
  )
}

/**
 * La curva de equity de Resumen (spec §11.1): rangos hoy / 7 días / 30 días / todo (7 días
 * por defecto, todo en un replay), el saldo y los originales como líneas opcionales
 * (apagadas al entrar) y la tabla con los mismos valores para quien no lee el gráfico.
 */
export function EquitySection({ equity, livePoint, past, now }: EquitySectionProps) {
  const [range, setRange] = useState<EquityRange>(equity.defaultRange)
  // El fundido al cambiar de rango es respuesta a un toque: no corre al cargar.
  const [touched, setTouched] = useState(false)
  const [showSaldo, setShowSaldo] = useState(false)
  const [showShadow, setShowShadow] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const tableId = useId()

  // Estable entre consultas que no trajeron nada nuevo: la geometría se recalcula sólo si cambió la curva.
  const curve = useMemo(() => withLivePoint(equity.ranges[range], livePoint), [equity.ranges, range, livePoint])
  const { points } = curve
  const hasShadow = points.some((p) => p.shadowEquity !== null)
  const anyPoints = Object.values(equity.ranges).some((r) => r.points.length > 0)
  const options = (Object.keys(RANGE_LABELS) as EquityRange[]).map((value) => ({
    value,
    label: value === 'hoy' && past ? 'Último día' : RANGE_LABELS[value],
  }))
  const edge = (at: number) => (range === 'hoy' ? formatTimeBA(at) : shortDate(at, now))
  const rows = tableOpen ? valueRows(points, range) : []

  return (
    <section aria-label="Curva de equity" className="panel flex flex-col gap-3 p-3">
      {anyPoints && (
        <Segment
          options={options}
          value={range}
          onChange={(next) => {
            setTouched(true)
            setRange(next)
          }}
          label="Rango de la curva"
          className="self-start"
        />
      )}
      {points.length === 0 ? (
        <p className="flex h-[180px] items-center justify-center px-6 text-center text-sm text-pretty text-muted desktop:h-[220px]">
          {anyPoints || past ? 'No hay puntos de la curva en este rango.' : 'La curva aparece cuando el bot escriba su primer punto.'}
        </p>
      ) : (
        <>
          {/* Otro rango es otra curva: se monta de nuevo, sin la lectura del anterior. */}
          <motion.div key={range} initial={touched ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={fade}>
            <EquityChart
              points={points}
              from={curve.from}
              to={curve.to}
              tone={rangeTone(points)}
              showSaldo={showSaldo}
              showShadow={showShadow && hasShadow}
              trailingGapMs={past ? Number.POSITIVE_INFINITY : equity.ranges[range].bucketMs + EQUITY_GAP_MS}
              label={`Curva de equity ${RANGE_NAMES[range]}`}
              formatWhen={(at) => `${shortDate(at, now)}, ${formatTimeBA(at)}`}
            />
          </motion.div>
          <div aria-hidden className="-mt-1 flex justify-between pl-11 text-xs text-muted tabular-nums">
            <span>{edge(curve.from)}</span>
            <span>{edge(curve.to)}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <div className="flex flex-wrap items-center gap-x-1.5">
              <SeriesToggle pressed={showSaldo} onToggle={() => setShowSaldo((v) => !v)} series="saldo">
                Saldo
              </SeriesToggle>
              {hasShadow && (
                <SeriesToggle pressed={showShadow} onToggle={() => setShowShadow((v) => !v)} series="shadow">
                  Originales
                </SeriesToggle>
              )}
            </div>
            <button
              type="button"
              aria-expanded={tableOpen}
              aria-controls={tableId}
              onClick={() => setTableOpen((v) => !v)}
              className="pressable -my-1.5 inline-flex min-h-11 items-center rounded-control px-1 text-sm font-medium text-muted hover:text-ink"
            >
              {tableOpen ? 'Ocultar los valores' : 'Ver los valores'}
            </button>
          </div>
          <div id={tableId} hidden={!tableOpen}>
            {tableOpen && (
              <table className="w-full text-sm tabular-nums">
                <caption className="sr-only">Equity y saldo al cierre de cada {range === 'hoy' ? 'hora' : 'día'}</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 text-left font-medium">
                      {range === 'hoy' ? 'Hora' : 'Día'}
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Equity
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Saldo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ at, point }) => (
                    <tr key={at} className="border-t border-line">
                      <th scope="row" className="py-1.5 text-left font-normal">
                        {range === 'hoy' ? formatTimeBA(at) : shortDate(at, now)}
                      </th>
                      <td className="py-1.5 text-right">{formatUsd(point.equity)}</td>
                      <td className="py-1.5 text-right">{formatUsd(point.saldo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  )
}
