'use client'

import clsx from 'clsx'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { formatNumber, formatUsd } from '@/lib/format'
import type { EquityPointView } from '@/lib/queries/sql/equity'
import { CHART_H, CHART_W, equityGeometry, nearestIndex, type Interval } from './equity-geometry'
import { SERIES_STROKE } from './series-style'

// La curva de equity propia (spec §11.1 y §11.2, skill dataviz): línea de 2 px, área al
// 10%, grilla hairline sólida, huecos punteados, saldo y originales opcionales como
// líneas finas. Con mouse, la cruz sigue al puntero; en el celu, tocar y mantener
// muestra fecha y valor en una etiqueta encima y deja recorrer la curva con el dedo
// sin mover la página. Con teclado, las flechas recorren los puntos.

/** Lo que hay que mantener el dedo quieto para que el toque sea "mantener" y no un scroll. */
export const HOLD_MS = 280
/** Más que esto antes del "mantener" es un scroll: el gesto es de la página. */
const MOVE_TOLERANCE = 10

export type ChartTone = 'gain' | 'loss'

export interface EquityChartProps {
  points: EquityPointView[]
  from: number
  to: number
  tone: ChartTone
  showSaldo: boolean
  showShadow: boolean
  /** Desde cuánto sin puntos al final se dibuja el hueco (sólo en la simulación activa). */
  trailingGapMs: number
  /** Nombre del gráfico para lectores de pantalla ("Curva de equity de los últimos 7 días"). */
  label: string
  /** Cuándo es un punto, para la etiqueta: "31 oct, 14:32". */
  formatWhen: (at: number) => string
  className?: string
}

const pctX = (v: number) => `${(v / CHART_W) * 100}%`
const pctY = (v: number) => `${(v / CHART_H) * 100}%`

type Hold = { pointerId: number; x: number; y: number; timer: number | null }

export function EquityChart({ points, from, to, tone, showSaldo, showShadow, trailingGapMs, label, formatWhen, className }: EquityChartProps) {
  const g = useMemo(
    () => equityGeometry({ points, from, to, showSaldo, showShadow, trailingGapMs }),
    [points, from, to, showSaldo, showShadow, trailingGapMs],
  )
  // El momento que se lee, no su índice: la consulta en vivo trae un arreglo nuevo cada
  // 5 s (con el punto de ahora al final) y la lectura tiene que seguir en el mismo punto.
  const [activeAt, setActiveAt] = useState<number | null>(null)
  const plot = useRef<HTMLDivElement>(null)
  const hold = useRef<Hold | null>(null)
  const scrubbing = useRef(false)
  const ids = `equity-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const color = tone === 'gain' ? 'var(--gain)' : 'var(--loss)'

  const clearHold = () => {
    if (hold.current?.timer != null) window.clearTimeout(hold.current.timer)
    hold.current = null
  }

  // Con el dedo recorriendo la curva la página no se mueve: iOS sólo deja cancelar el scroll así.
  useEffect(() => {
    const node = plot.current
    if (!node) return
    const onTouchMove = (event: TouchEvent) => {
      if (scrubbing.current && event.cancelable) event.preventDefault()
    }
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => node.removeEventListener('touchmove', onTouchMove)
  }, [])

  useEffect(() => () => clearHold(), [])

  if (!g) return null
  const last = points.at(-1)
  if (!last) return null
  // Si el punto que se leía ya no está (el de ahora se reemplaza en cada consulta), el más cercano.
  const active = activeAt === null ? null : nearestIndex(points, activeAt)

  const pointAt = (clientX: number): number | null => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || box.width === 0) return null
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return points[nearestIndex(points, g.x.invert(fraction * CHART_W))]?.at ?? null
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') {
      setActiveAt(pointAt(event.clientX))
      return
    }
    clearHold()
    const target = event.currentTarget
    const { pointerId, clientX, clientY } = event
    hold.current = {
      pointerId,
      x: clientX,
      y: clientY,
      timer: window.setTimeout(() => {
        if (!hold.current) return
        hold.current.timer = null
        scrubbing.current = true
        target.setPointerCapture?.(pointerId)
        setActiveAt(pointAt(clientX))
      }, HOLD_MS),
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || scrubbing.current) {
      setActiveAt(pointAt(event.clientX))
      return
    }
    const h = hold.current
    if (h && h.pointerId === event.pointerId && Math.hypot(event.clientX - h.x, event.clientY - h.y) > MOVE_TOLERANCE) clearHold()
  }

  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    clearHold()
    if (event.pointerType === 'mouse') return
    if (scrubbing.current) event.currentTarget.releasePointerCapture?.(event.pointerId)
    scrubbing.current = false
    setActiveAt(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setActiveAt(null)
      return
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = Math.min(points.length - 1, Math.max(0, (active ?? points.length - 1) + step))
    setActiveAt(points[next]?.at ?? null)
  }

  const shown = active === null ? null : points[active]
  const line = { fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' } as const

  return (
    <div className={clsx('relative h-[180px] desktop:h-[220px]', className)}>
      {/* Las cifras del eje van en su propia columna: nunca quedan debajo de la curva. */}
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
        ref={plot}
        tabIndex={0}
        role="group"
        aria-label={`${label}. Con las flechas recorrés los puntos.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setActiveAt(null)}
        onContextMenu={(event) => scrubbing.current && event.preventDefault()}
        onKeyDown={onKeyDown}
        onFocus={() => setActiveAt((at) => at ?? last.at)}
        onBlur={() => setActiveAt(null)}
        className="absolute inset-y-0 right-0 left-11 touch-pan-y rounded-[6px] select-none [-webkit-touch-callout:none]"
      >
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={`${ids}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.1} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
            {/* La misma curva, recortada: sólida donde los puntos son continuos, punteada en los huecos. */}
            <Clip id={`${ids}-solid`} intervals={g.solid} />
            <Clip id={`${ids}-gaps`} intervals={g.gaps} />
          </defs>
          {g.ticks.map((t) => (
            <line key={t} x1={0} x2={CHART_W} y1={g.y(t)} y2={g.y(t)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={g.area} fill={`url(#${ids}-area)`} />
          {g.shadow && <path data-series="shadow" d={g.shadow} {...line} {...SERIES_STROKE.shadow} />}
          {g.saldo && <path data-series="saldo" d={g.saldo} {...line} {...SERIES_STROKE.saldo} />}
          {g.solid.length > 0 && <path d={g.line} clipPath={`url(#${ids}-solid)`} stroke={color} strokeWidth={2} {...line} />}
          {g.gaps.length > 0 && <path d={g.line} clipPath={`url(#${ids}-gaps)`} stroke={color} {...line} {...dotted} />}
          {g.trailing && (
            <line x1={g.trailing.x1} y1={g.trailing.y1} x2={g.trailing.x2} y2={g.trailing.y2} stroke="var(--muted)" {...line} {...dotted} />
          )}
        </svg>
        {g.dot && !shown && <Dot x={g.dot.x} y={g.dot.y} color={color} small />}
        {shown ? (
          <Crosshair
            x={g.x(shown.at)}
            y={g.y}
            point={shown}
            color={color}
            when={formatWhen(shown.at)}
            showSaldo={showSaldo}
            showShadow={showShadow}
          />
        ) : (
          <Dot x={g.end.x} y={g.end.y} color={color} />
        )}
      </div>
    </div>
  )
}

const dotted = { strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '0 6' } as const

function Clip({ id, intervals }: { id: string; intervals: Interval[] }) {
  return (
    <clipPath id={id}>
      {intervals.map((r) => (
        <rect key={`${r.x1}-${r.x2}`} x={r.x1} y={-CHART_H} width={r.x2 - r.x1} height={CHART_H * 3} />
      ))}
    </clipPath>
  )
}

function Dot({ x, y, color, small = false }: { x: number; y: number; color: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx('absolute -translate-1/2 rounded-full ring-2 ring-surface', small ? 'size-1.5' : 'size-2.5')}
      style={{ left: pctX(x), top: pctY(y), backgroundColor: color }}
    />
  )
}

interface CrosshairProps {
  x: number
  y: (value: number) => number
  point: EquityPointView
  color: string
  when: string
  showSaldo: boolean
  showShadow: boolean
}

function Crosshair({ x, y, point, color, when, showSaldo, showShadow }: CrosshairProps) {
  // La etiqueta va arriba, del lado con más lugar: el dedo queda abajo y no la tapa.
  const anchorRight = x > CHART_W / 2
  return (
    <>
      <span aria-hidden className="absolute inset-y-0 w-px -translate-x-1/2 bg-muted/60" style={{ left: pctX(x) }} />
      <Dot x={x} y={y(point.equity)} color={color} />
      <div
        role="status"
        className="pointer-events-none absolute -top-1 z-10 flex flex-col gap-0.5 rounded-control border border-line bg-surface px-2.5 py-2 text-xs"
        style={anchorRight ? { right: `calc(${100 - (x / CHART_W) * 100}% + 10px)` } : { left: `calc(${pctX(x)} + 10px)` }}
      >
        <span className="text-muted">{when}</span>
        <ReadoutRow keyColor={color} value={point.equity} label="equity" />
        {showSaldo && <ReadoutRow keyColor="color-mix(in oklab, var(--ink) 55%, transparent)" value={point.saldo} label="saldo" />}
        {showShadow && point.shadowEquity !== null && <ReadoutRow keyColor="var(--muted)" value={point.shadowEquity} label="originales" />}
      </div>
    </>
  )
}

function ReadoutRow({ keyColor, value, label }: { keyColor: string; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="h-0.5 w-3 rounded-chip" style={{ backgroundColor: keyColor }} />
      <span className="font-semibold tabular-nums">{formatUsd(value)}</span>
      <span className="text-muted">{label}</span>
    </span>
  )
}
