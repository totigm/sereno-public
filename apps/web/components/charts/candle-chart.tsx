'use client'

import clsx from 'clsx'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  TickMarkType,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { Candle } from '@sereno/core'
import { formatPrice } from '@sereno/core/src/journal/format'
import { BA_TZ } from '@/lib/format'
import { priceTickLabels } from './price-ticks'
import { useChartPalette, type ChartPalette } from './use-chart-palette'

export type ChartTone = 'ink' | 'muted' | 'gain' | 'loss'

/** Una línea de nivel sobre las velas (entrada, stop, take profit); con `step`, escalonada. */
export interface ChartLine {
  id: string
  /** Instantes en ms; se pegan a la vela que los contiene. */
  points: { at: number; value: number }[]
  tone: ChartTone
  dashed?: boolean
  step?: boolean
}

export interface ChartMarker {
  at: number
  tone: ChartTone
  shape: 'arrowUp' | 'arrowDown' | 'circle'
  position: 'aboveBar' | 'belowBar'
}

export interface CandleChartProps {
  candles: Candle[]
  lines?: ChartLine[]
  markers?: ChartMarker[]
  /** Qué muestra, para lectores de pantalla: la tabla equivalente va al lado (la leyenda con los valores). */
  label: string
  className?: string
}

/** Con menos velas no hay gráfico que leer: va el vacío. */
export const MIN_CANDLES = 2

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const
const wallFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BA_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
})

// La librería trata todo instante como UTC: las velas se le pasan corridas a la hora de
// pared de Buenos Aires, así las marcas de día caen a las 00:00 de acá y las etiquetas
// se leen en UTC sin volver a convertir.
function wallOffsetMs(at: number): number {
  const p = Object.fromEntries(wallFormat.formatToParts(at).map((part) => [part.type, Number(part.value)]))
  return Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0) - Math.floor(at / 60_000) * 60_000
}

const pad = (n: number) => String(n).padStart(2, '0')
const wallOf = (time: Time) => new Date(typeof time === 'number' ? time * 1000 : 0)
const wallTime = (time: Time) => `${pad(wallOf(time).getUTCHours())}:${pad(wallOf(time).getUTCMinutes())}`
const wallDay = (time: Time) => `${wallOf(time).getUTCDate()} ${MONTHS[wallOf(time).getUTCMonth()] ?? ''}`

/** La vela (su apertura) que contiene `at`; antes de la primera o después de la última, la del borde. */
function snap(at: number, opens: number[]): number {
  let lo = 0
  let hi = opens.length - 1
  if (at <= (opens[0] ?? at)) return opens[0] ?? at
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((opens[mid] ?? 0) <= at) lo = mid
    else hi = mid - 1
  }
  return opens[lo] ?? at
}

function colorOf(tone: ChartTone, palette: ChartPalette): string {
  return palette[tone]
}

function draw(container: HTMLElement, props: CandleChartProps, palette: ChartPalette): IChartApi {
  // Argentina no tiene horario de verano: un solo corrimiento para todo el tramo.
  const offset = wallOffsetMs(props.candles.at(-1)?.openTime ?? 0)
  const seconds = (ms: number) => Math.floor((ms + offset) / 1000) as UTCTimestamp
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: palette.muted,
      fontFamily: palette.font,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: palette.line } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      fixLeftEdge: true,
      fixRightEdge: true,
      tickMarkFormatter: (time: Time, type: TickMarkType) =>
        type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? wallTime(time) : wallDay(time),
    },
    localization: {
      locale: 'es-AR',
      priceFormatter: formatPrice,
      tickmarksPriceFormatter: priceTickLabels,
      timeFormatter: (time: Time) => `${wallDay(time)} ${wallTime(time)}`,
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: palette.muted, labelBackgroundColor: palette.ink },
      horzLine: { color: palette.muted, labelBackgroundColor: palette.ink },
    },
    // Dentro de una hoja: el arrastre vertical es del scroll y la rueda no hace zoom.
    handleScroll: { vertTouchDrag: false, mouseWheel: false, horzTouchDrag: true, pressedMouseMove: true },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false },
  })

  // Velas en neutro (huecas las que suben): el color queda para los niveles del trade.
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: palette.surface,
    downColor: palette.muted,
    borderUpColor: palette.muted,
    borderDownColor: palette.muted,
    wickUpColor: palette.muted,
    wickDownColor: palette.muted,
    priceLineVisible: false,
    lastValueVisible: false,
  })
  candles.setData(
    props.candles.map((c) => ({ time: seconds(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close })),
  )

  const opens = props.candles.map((c) => c.openTime)
  for (const line of props.lines ?? []) {
    const series = chart.addSeries(LineSeries, {
      color: colorOf(line.tone, palette),
      lineWidth: line.dashed ? 1 : 2,
      lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
      lineType: line.step ? LineType.WithSteps : LineType.Simple,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    // Varios puntos pueden caer en la misma vela: queda el último (el stop vigente al cierre de esa vela).
    const byTime = new Map<number, number>()
    for (const p of line.points) byTime.set(snap(p.at, opens), p.value)
    series.setData([...byTime].sort(([a], [b]) => a - b).map(([at, value]) => ({ time: seconds(at), value })))
  }

  createSeriesMarkers(
    candles,
    (props.markers ?? [])
      .map((m) => ({ time: seconds(snap(m.at, opens)), position: m.position, shape: m.shape, color: colorOf(m.tone, palette) }))
      .sort((a, b) => a.time - b.time),
  )
  chart.timeScale().fitContent()
  return chart
}

/**
 * Velas con lightweight-charts (sólo en el cliente: se importa con `LazyCandleChart`).
 * Los colores salen de los tokens CSS y se rearma al pasar de claro a oscuro; alto
 * fijo de 220 px en el celu y sin scroll vertical propio (spec §11.3).
 */
export function CandleChart({ candles, lines, markers, label, className }: CandleChartProps) {
  const container = useRef<HTMLDivElement>(null)
  const palette = useChartPalette()
  const enough = candles.length >= MIN_CANDLES

  useEffect(() => {
    const node = container.current
    if (!node || !palette || !enough) return
    const chart = draw(node, { candles, lines: lines ?? [], markers: markers ?? [], label }, palette)
    return () => chart.remove()
  }, [candles, lines, markers, label, palette, enough])

  if (!enough) {
    return (
      <div className={clsx('flex h-[220px] items-center justify-center rounded-control bg-ink/4 px-6 text-center text-sm text-muted desktop:h-[260px]', className)}>
        Todavía no hay velas suficientes para dibujar este tramo.
      </div>
    )
  }

  // El gráfico se queda con cualquier gesto que empieza sobre él: no arrastra la hoja.
  return (
    <div
      ref={container}
      role="img"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      className={clsx('h-[220px] w-full desktop:h-[260px]', className)}
    />
  )
}
