'use client'

import { scaleLinear } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Candle } from '@sereno/core'
import { formatPrice } from '@sereno/core/src/journal/format'
import { BA_TZ, formatTimeBA, startOfDayBA } from '@/lib/format'

export type LineTone = 'gain' | 'loss' | 'muted'

export interface PriceLineProps {
  candles: readonly Candle[]
  /** Subió o bajó en el tramo; apagado sin conexión. */
  tone: LineTone
  /** Nombre accesible del gráfico, con los valores que se leen en él. */
  label: string
  /** Etiquetas de los extremos del eje del tiempo ("hace 48 h", "ahora"). */
  from: string
  to: string
}

/** Alto fijo en la hoja (spec §11.3). */
export const CHART_HEIGHT = 220
// Arriba queda lugar para la etiqueta del punto tocado; abajo, para la del mínimo.
const TOP = 30
const BOTTOM = 20
const FALLBACK_WIDTH = 320
const DOT_RADIUS = 4

const shortDate = new Intl.DateTimeFormat('es-AR', { timeZone: BA_TZ, day: 'numeric', month: 'numeric' })

function pointLabel(at: number, end: number, price: number): string {
  const day = startOfDayBA(at) === startOfDayBA(end) ? '' : `${shortDate.format(at)} `
  return `${day}${formatTimeBA(at)} · ${formatPrice(price)}`
}

/** El índice de la vela más cercana a `t` (las velas vienen ordenadas por tiempo). */
function nearest(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((times[mid] ?? 0) < t) lo = mid
    else hi = mid
  }
  return Math.abs((times[hi] ?? 0) - t) < Math.abs((times[lo] ?? 0) - t) ? hi : lo
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * Línea de precio de la moneda con el área al 10% (spec §11.2, dataviz): extremos
 * rotulados sobre la grilla y el tramo de tiempo abajo, así nada depende del toque.
 * Tocar y mantener (o pasar el puntero) muestra hora y precio arriba. Captura todo
 * gesto que empieza sobre ella: la hoja no se arrastra desde el gráfico.
 */
export function PriceLine({ candles, tone, label, from, to }: PriceLineProps) {
  const box = useRef<HTMLDivElement>(null)
  const pressed = useRef(false)
  const measured = useWidth(box)
  const width = measured > 0 ? measured : FALLBACK_WIDTH
  const [active, setActive] = useState<number | null>(null)

  const times = candles.map((c) => c.closeTime)
  const closes = candles.map((c) => c.close)
  const first = times[0] ?? 0
  const last = times.at(-1) ?? 0
  const low = Math.min(...closes)
  const high = Math.max(...closes)
  const x = scaleLinear().domain([first, last]).range([DOT_RADIUS, width - DOT_RADIUS])
  const y = scaleLinear().domain(low === high ? [low * 0.99, high * 1.01] : [low, high]).range([CHART_HEIGHT - BOTTOM, TOP])
  const path = line<Candle>().x((c) => x(c.closeTime)).y((c) => y(c.close)).curve(curveMonotoneX)(candles) ?? ''
  const fill =
    area<Candle>()
      .x((c) => x(c.closeTime))
      .y0(CHART_HEIGHT - BOTTOM)
      .y1((c) => y(c.close))
      .curve(curveMonotoneX)(candles) ?? ''
  const color = `var(--${tone})`

  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setActive(nearest(times, x.invert(event.clientX - rect.left)))
  }

  const point = active === null ? null : candles[active]
  const tip = point ? pointLabel(point.closeTime, last, point.close) : null
  // La etiqueta se centra en el punto sin salirse del gráfico (≈ 6,5px por carácter a 12px).
  const tipHalf = tip ? (tip.length * 6.5) / 2 + 8 : 0
  const tipX = point ? Math.min(Math.max(x(point.closeTime), tipHalf), width - tipHalf) : 0

  return (
    <figure className="flex flex-col gap-1.5">
      <div
        ref={box}
        className="relative touch-none select-none"
        style={{ height: CHART_HEIGHT }}
        onPointerDown={(event) => {
          // El gráfico se queda con el gesto: la hoja no empieza a arrastrarse desde acá.
          event.stopPropagation()
          pressed.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          track(event)
        }}
        onPointerMove={(event) => {
          if (pressed.current || event.pointerType === 'mouse') track(event)
        }}
        onPointerUp={(event) => {
          pressed.current = false
          if (event.pointerType !== 'mouse') setActive(null)
        }}
        onPointerCancel={() => {
          pressed.current = false
          setActive(null)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && !pressed.current) setActive(null)
        }}
      >
        <svg role="img" aria-label={label} width={width} height={CHART_HEIGHT} className="block overflow-visible">
          <line x1={0} x2={width} y1={y(high)} y2={y(high)} stroke="var(--line)" strokeWidth={1} />
          <line x1={0} x2={width} y1={y(low)} y2={y(low)} stroke="var(--line)" strokeWidth={1} />
          <path d={fill} fill={color} fillOpacity={0.1} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last)} cy={y(closes.at(-1) ?? low)} r={DOT_RADIUS} fill={color} stroke="var(--surface)" strokeWidth={2} />
          <text x={0} y={y(high) - 6} className="fill-muted text-[0.6875rem] tabular-nums">
            {formatPrice(high)}
          </text>
          <text x={0} y={y(low) + 14} className="fill-muted text-[0.6875rem] tabular-nums">
            {formatPrice(low)}
          </text>
          {point && (
            <g aria-hidden>
              <line x1={x(point.closeTime)} x2={x(point.closeTime)} y1={TOP - 4} y2={CHART_HEIGHT - BOTTOM} stroke="var(--muted)" strokeWidth={1} />
              <circle cx={x(point.closeTime)} cy={y(point.close)} r={DOT_RADIUS} fill={color} stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {tip && (
          <span
            aria-hidden
            style={{ left: tipX }}
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-chip border border-line bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums"
          >
            {tip}
          </span>
        )}
      </div>
      <figcaption className="flex justify-between text-[0.6875rem] text-muted">
        <span>{from}</span>
        <span>{to}</span>
      </figcaption>
    </figure>
  )
}
