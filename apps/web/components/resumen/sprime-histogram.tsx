'use client'

import clsx from 'clsx'
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { HistogramBin } from '@sereno/core/src/replay/types'
import { plural } from '@/components/aprendizaje/labels'
import { formatNumber, formatPct } from '@/lib/format'
import { beyondThreshold, binLabel, thresholdShare } from './report-text'

export interface SprimeHistogramProps {
  bins: readonly HistogramBin[]
  /** El umbral con que terminó el replay: más allá de ±θ, el bot puede abrir. */
  theta: number
}

const pct = (fraction: number) => `${fraction * 100}%`

function tallestIndex(bins: readonly HistogramBin[]): number {
  return bins.reduce((best, bin, i) => (bin.count > (bins[best]?.count ?? -1) ? i : best), 0)
}

/**
 * El histograma de S′ del replay (spec §9, skill dataviz): una barra por cada 0,05 entre −1
 * y +1, plena si pasó el umbral y tenue si no, con ±θ punteado. La lectura va en una línea arriba (no
 * tapa las barras): con el puntero o el dedo, la barra de abajo; con teclado, las flechas.
 * "Ver los valores" muestra la tabla equivalente.
 */
export function SprimeHistogram({ bins, theta }: SprimeHistogramProps) {
  const [active, setActive] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const plot = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const tableId = useId()
  const max = Math.max(1, ...bins.map((b) => b.count))
  const { beyond, total } = thresholdShare(bins, theta)
  const shown = active === null ? null : bins[active]

  const summary =
    total === 0
      ? 'No hubo decisiones con la vela del ciclo.'
      : `El ${formatPct(beyond / total, 0, false)} de las decisiones (${formatNumber(beyond, 0)} de ${formatNumber(total, 0)}) pasó el umbral.`
  const readout = shown ? `${binLabel(shown)}: ${plural(shown.count, 'decisión', 'decisiones')}.` : summary
  const toggleText = tableOpen ? 'Ocultar los valores' : 'Ver los valores'

  const indexAt = (clientX: number): number | null => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || box.width === 0 || bins.length === 0) return null
    const fraction = (clientX - box.left) / box.width
    return Math.min(bins.length - 1, Math.max(0, Math.floor(fraction * bins.length)))
  }

  const onPointer = (event: PointerEvent<HTMLDivElement>) => setActive(indexAt(event.clientX))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setActive(null)
      return
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    setActive((i) => Math.min(bins.length - 1, Math.max(0, (i ?? tallestIndex(bins)) + step)))
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-[0.9375rem] font-semibold">
        Histograma de S′
      </h3>
      <p className="text-sm text-pretty text-muted">
        {`Cuántas decisiones dieron cada valor de S′, de −1 (short) a +1 (long). Afuera de las líneas punteadas (θ\u00a0${formatNumber(theta, 2)}, el umbral con que terminó) el bot puede abrir.`}
      </p>
      <p aria-live="polite" className="min-h-6 text-[0.9375rem] tabular-nums">
        {readout}
      </p>
      <div
        ref={plot}
        role="group"
        tabIndex={0}
        aria-label="Histograma de S′. Con las flechas recorrés las barras."
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onPointerLeave={() => setActive(null)}
        onPointerCancel={() => setActive(null)}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((i) => i ?? tallestIndex(bins))}
        onBlur={() => setActive(null)}
        className="relative flex h-32 touch-pan-y items-end gap-[2px] border-b border-line select-none"
      >
        {bins.map((bin) => (
          <span
            key={bin.from}
            aria-hidden
            className={clsx('flex-1 rounded-t-[2px]', beyondThreshold(bin, theta) ? 'bg-ink' : 'bg-ink/25')}
            style={{ height: pct(bin.count / max), minHeight: bin.count > 0 ? 1 : 0 }}
          />
        ))}
        {[-theta, theta].map((at) => (
          <span key={at} aria-hidden className="absolute inset-y-0 border-l border-dashed border-muted" style={{ left: pct((at + 1) / 2) }} />
        ))}
        {active !== null && (
          <span aria-hidden className="absolute -inset-y-1 w-px -translate-x-1/2 bg-muted/60" style={{ left: pct((active + 0.5) / bins.length) }} />
        )}
      </div>
      <div aria-hidden className="flex justify-between text-xs text-muted tabular-nums">
        <span>−1 · short</span>
        <span>0</span>
        <span>+1 · long</span>
      </div>
      <button
        type="button"
        aria-expanded={tableOpen}
        aria-controls={tableId}
        aria-label={`${toggleText} del histograma`}
        onClick={() => setTableOpen((v) => !v)}
        className="pressable -my-1.5 inline-flex min-h-11 items-center self-start rounded-control text-sm font-medium text-muted hover:text-ink"
      >
        {toggleText}
      </button>
      <div id={tableId} hidden={!tableOpen}>
        {tableOpen && (
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">Decisiones por valor de S′</caption>
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-1.5 text-left font-medium">
                  S′
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Decisiones
                </th>
              </tr>
            </thead>
            <tbody>
              {bins.map((bin) => (
                <tr key={bin.from} className="border-t border-line">
                  <th scope="row" className="py-1.5 text-left font-normal">
                    {binLabel(bin)}
                  </th>
                  <td className="py-1.5 text-right">{formatNumber(bin.count, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
