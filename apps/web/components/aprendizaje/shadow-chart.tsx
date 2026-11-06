'use client'

import { scaleLinear } from 'd3-scale'
import { curveMonotoneX, line } from 'd3-shape'
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { EM_DASH, formatNumber, formatTimeBA, formatUsd, startOfDayBA } from '@/lib/format'
import type { EquityPointView } from '@/lib/queries/sql/equity'
import { shortDate } from './labels'

// Lo aprendido contra los originales (spec §8, "Sombra"): dos líneas de 2 px sobre el
// mismo eje, sin área (dos rellenos se ensucian), grilla hairline y la ventana de la
// comparación marcada. El SVG se estira al ancho (`preserveAspectRatio="none"`) con
// trazos que no escalan; textos y puntos van en HTML encima, así no se deforman y la
// pantalla se arma igual en el servidor, sin medir nada.

const W = 600
const H = 160
const PAD_TOP = 14
const PAD_BOTTOM = 6

export interface ShadowChartProps {
  points: EquityPointView[]
  /** Desde dónde mide la comparación (se sombrea); null si la curva entera está adentro. */
  windowFrom: number | null
  windowLabel: string
  now: number
}

interface Geometry {
  x: (at: number) => number
  y: (equity: number) => number
  ticks: number[]
  learned: string
  shadow: string
}

function geometry(points: EquityPointView[]): Geometry | null {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last || last.at <= first.at) return null
  const values = points.flatMap((p) => (p.shadowEquity === null ? [p.equity] : [p.equity, p.shadowEquity]))
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.08, 1)
  // Sin `nice()`: redondear el dominio a la grilla deja medio gráfico vacío cuando la
  // curva se mueve poco; las líneas de la grilla caen donde caigan adentro.
  const y = scaleLinear()
    .domain([lo - pad, hi + pad])
    .range([H - PAD_BOTTOM, PAD_TOP])
  const x = scaleLinear().domain([first.at, last.at]).range([0, W])
  const learned = line<EquityPointView>()
    .x((p) => x(p.at))
    .y((p) => y(p.equity))
    .curve(curveMonotoneX)
  // La sombra puede faltar en algunos puntos: la línea se corta ahí en vez de caer a cero.
  const shadow = line<EquityPointView>()
    .defined((p) => p.shadowEquity !== null)
    .x((p) => x(p.at))
    .y((p) => y(p.shadowEquity ?? 0))
    .curve(curveMonotoneX)
  return { x, y, ticks: y.ticks(3), learned: learned(points) ?? '', shadow: shadow(points) ?? '' }
}

const pctX = (v: number) => `${(v / W) * 100}%`
const pctY = (v: number) => `${(v / H) * 100}%`

/** El punto más cercano a `at` (los puntos vienen ordenados por tiempo). */
function nearest(points: EquityPointView[], at: number): number {
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.at ?? 0) <= at) lo = mid
    else hi = mid
  }
  const a = points[lo]?.at ?? 0
  const b = points[hi]?.at ?? 0
  return Math.abs(at - a) <= Math.abs(b - at) ? lo : hi
}

export function ShadowChart({ points, windowFrom, windowLabel, now }: ShadowChartProps) {
  const g = useMemo(() => geometry(points), [points])
  const [active, setActive] = useState<number | null>(null)
  if (!g) return null

  const first = points[0]!
  const last = points.at(-1)!
  const shown = active === null ? null : points[active]
  const bandX = windowFrom !== null && windowFrom > first.at ? g.x(windowFrom) : null

  const track = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    setActive(nearest(points, first.at + fraction * (last.at - first.at)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (event.key === 'Escape') setActive(null)
    if (step === 0) return
    event.preventDefault()
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? points.length - 1) + step)))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-[160px] desktop:h-[200px]">
        {/* Las cifras del eje van en su propia columna: nunca quedan debajo de una línea. */}
        {g.ticks.map((t) => (
          <span
            key={t}
            aria-hidden
            className="absolute left-0 w-9 -translate-y-1/2 text-right text-[0.6875rem] leading-none text-muted tabular-nums"
            style={{ top: pctY(g.y(t)) }}
          >
            {formatNumber(t, 0)}
          </span>
        ))}
        <div
          tabIndex={0}
          role="group"
          aria-label="Curvas de lo aprendido y de los originales. Con las flechas recorrés los días."
          onPointerMove={track}
          onPointerDown={track}
          onPointerLeave={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((i) => i ?? points.length - 1)}
          onBlur={() => setActive(null)}
          className="absolute inset-y-0 right-0 left-11 touch-pan-y select-none"
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full overflow-visible">
            {bandX !== null && <rect x={bandX} y={0} width={W - bandX} height={H} fill="var(--ink)" opacity={0.04} />}
            {g.ticks.map((t) => (
              <line key={t} x1={0} x2={W} y1={g.y(t)} y2={g.y(t)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={g.shadow} fill="none" stroke="var(--muted)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <path d={g.learned} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {bandX !== null && (
            <span aria-hidden className="absolute top-1 pl-1.5 text-[0.6875rem] leading-none text-muted" style={{ left: pctX(bandX) }}>
              {windowLabel}
            </span>
          )}
          {shown ? (
            <Crosshair point={shown} x={g.x(shown.at)} y={g.y} now={now} />
          ) : (
            <>
              {last.shadowEquity !== null && <Dot x={W} y={g.y(last.shadowEquity)} tone="muted" />}
              <Dot x={W} y={g.y(last.equity)} tone="ink" />
            </>
          )}
        </div>
      </div>
      <div aria-hidden className="flex justify-between pl-11 text-xs text-muted tabular-nums">
        <span>{shortDate(first.at, now)}</span>
        <span>{shortDate(last.at, now)}</span>
      </div>
      <DailyTable points={points} now={now} />
    </div>
  )
}

function Dot({ x, y, tone }: { x: number; y: number; tone: 'ink' | 'muted' }) {
  return (
    <span
      aria-hidden
      className={`absolute size-2.5 -translate-1/2 rounded-full ring-2 ring-surface ${tone === 'ink' ? 'bg-ink' : 'bg-muted'}`}
      style={{ left: pctX(x), top: pctY(y) }}
    />
  )
}

function Crosshair({ point, x, y, now }: { point: EquityPointView; x: number; y: (v: number) => number; now: number }) {
  // La etiqueta se queda adentro del gráfico: se ancla al borde que tiene más lugar.
  const anchorRight = x > W / 2
  return (
    <>
      <span aria-hidden className="absolute inset-y-0 w-px -translate-x-1/2 bg-muted/60" style={{ left: pctX(x) }} />
      {point.shadowEquity !== null && <Dot x={x} y={y(point.shadowEquity)} tone="muted" />}
      <Dot x={x} y={y(point.equity)} tone="ink" />
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 z-10 flex flex-col gap-0.5 rounded-control border border-line bg-surface px-2.5 py-2 text-xs"
        style={anchorRight ? { right: `calc(${100 - (x / W) * 100}% + 10px)` } : { left: `calc(${pctX(x)} + 10px)` }}
      >
        <span className="text-muted">
          {shortDate(point.at, now)}, {formatTimeBA(point.at)}
        </span>
        <ReadoutRow tone="ink" value={point.equity} label="lo aprendido" />
        {point.shadowEquity !== null && <ReadoutRow tone="muted" value={point.shadowEquity} label="originales" />}
      </div>
    </>
  )
}

function ReadoutRow({ tone, value, label }: { tone: 'ink' | 'muted'; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`h-0.5 w-3 rounded-chip ${tone === 'ink' ? 'bg-ink' : 'bg-muted'}`} />
      <span className="font-semibold tabular-nums">{formatUsd(value)}</span>
      <span className="text-muted">{label}</span>
    </span>
  )
}

/** La tabla equivalente (spec §11.2): el cierre de cada día de las dos carteras. */
function DailyTable({ points, now }: { points: EquityPointView[]; now: number }) {
  const days = new Map<number, EquityPointView>()
  for (const p of points) days.set(startOfDayBA(p.at), p)
  const rows = [...days.entries()].reverse()
  return (
    <details className="group mt-1 text-sm">
      <summary className="pressable inline-flex h-11 cursor-pointer list-none items-center font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Ver los valores por día</span>
        <span className="hidden group-open:inline">Ocultar los valores por día</span>
      </summary>
      <table className="w-full tabular-nums">
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="py-1.5 text-left font-medium">
              Día
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Lo aprendido
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Originales
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([day, p]) => (
            <tr key={day} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal">
                {shortDate(day, now)}
              </th>
              <td className="py-1.5 text-right">{formatUsd(p.equity)}</td>
              <td className="py-1.5 text-right">{p.shadowEquity === null ? EM_DASH : formatUsd(p.shadowEquity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
