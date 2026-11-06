import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Candle } from '@sereno/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CandleChart } from '@/components/charts/candle-chart'
import { setMedia } from '../media'

// lightweight-charts dibuja en canvas (jsdom no tiene): se reemplaza por un doble que
// guarda las opciones y los datos con que se lo llama.
const chart = vi.hoisted(() => {
  const series: { kind: string; options: Record<string, unknown>; data: unknown[] }[] = []
  const created: Record<string, unknown>[] = []
  const markers: unknown[][] = []
  return { series, created, markers, removed: { count: 0 } }
})

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles',
  LineSeries: 'line',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
  LineType: { Simple: 0, WithSteps: 1 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
  createChart: (_container: HTMLElement, options: Record<string, unknown>) => {
    chart.created.push(options)
    return {
      addSeries: (kind: string, options: Record<string, unknown>) => {
        const entry = { kind, options, data: [] as unknown[] }
        chart.series.push(entry)
        return { setData: (data: unknown[]) => (entry.data = data) }
      },
      timeScale: () => ({ fitContent: () => {} }),
      remove: () => (chart.removed.count += 1),
    }
  },
  createSeriesMarkers: (_series: unknown, list: unknown[]) => chart.markers.push(list),
}))

const M15 = 15 * 60_000
// 31 de octubre, 09:00 en Buenos Aires.
const T0 = Date.UTC(2026, 9, 31, 12, 0)
// La librería recibe la hora de pared de Buenos Aires (UTC−3) como si fuera UTC.
const wall = (ms: number) => (ms - 3 * 3_600_000) / 1000

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: T0 + i * M15,
    closeTime: T0 + (i + 1) * M15 - 1,
    open: 140 + i,
    high: 142 + i,
    low: 139 + i,
    close: 141 + i,
    volume: 10,
    quoteVolume: 1400,
    closed: true,
  }))
}

beforeEach(() => {
  chart.series.length = 0
  chart.created.length = 0
  chart.markers.length = 0
  chart.removed.count = 0
})

describe('gráfico de velas', () => {
  it('sin velas suficientes, un vacío que lo dice con el mismo alto', () => {
    render(<CandleChart candles={candles(1)} label="Velas de SOL" />)
    expect(screen.getByText('Todavía no hay velas suficientes para dibujar este tramo.')).toHaveClass('h-[220px]')
    expect(chart.created).toHaveLength(0)
  })

  it('dentro de una hoja: sin scroll vertical propio, sin zoom con la rueda, sin logo y sin grilla vertical', () => {
    render(<CandleChart candles={candles(4)} label="Velas de SOL" />)
    expect(screen.getByRole('img', { name: 'Velas de SOL' })).toHaveClass('h-[220px]')
    const [options] = chart.created as [Record<string, Record<string, unknown>>]
    expect(options.handleScroll).toMatchObject({ vertTouchDrag: false, mouseWheel: false })
    expect(options.layout).toMatchObject({ attributionLogo: false })
    expect(options.grid).toMatchObject({ vertLines: { visible: false } })
  })

  it('las líneas de nivel se pegan a la vela que contiene cada instante; el último valor de una vela manda', () => {
    render(
      <CandleChart
        candles={candles(4)}
        label="Velas de SOL"
        lines={[
          { id: 'stop', tone: 'loss', step: true, points: [{ at: T0 + 5 * 60_000, value: 138 }, { at: T0 + 10 * 60_000, value: 139 }, { at: T0 + 3 * M15 + 1, value: 140 }] },
        ]}
        markers={[{ at: T0 + M15 + 7 * 60_000, tone: 'ink', shape: 'arrowUp', position: 'belowBar' }]}
      />,
    )
    const stop = chart.series.find((s) => s.kind === 'line')
    expect(stop?.options).toMatchObject({ lineType: 1, lineWidth: 2 })
    expect(stop?.data).toEqual([
      { time: wall(T0), value: 139 },
      { time: wall(T0 + 3 * M15), value: 140 },
    ])
    expect(chart.markers[0]).toEqual([expect.objectContaining({ time: wall(T0 + M15), shape: 'arrowUp', position: 'belowBar' })])
  })

  it('las marcas del eje de precios llevan los decimales que pide su paso, no siempre dos', () => {
    render(<CandleChart candles={candles(4)} label="Velas de BTC" />)
    const [options] = chart.created as [{ localization: { tickmarksPriceFormatter: (prices: number[]) => string[] } }]
    expect(options.localization.tickmarksPriceFormatter([75_000, 75_500, 76_000])).toEqual(['75.000', '75.500', '76.000'])
  })

  it('las etiquetas van en hora de Buenos Aires y los días cortan a las 00:00 de acá', () => {
    render(<CandleChart candles={candles(4)} label="Velas de SOL" />)
    const [options] = chart.created as [{ timeScale: { tickMarkFormatter: (t: number, type: number) => string }; localization: { timeFormatter: (t: number) => string } }]
    expect(options.timeScale.tickMarkFormatter(wall(T0 + M15), 3)).toBe('09:15')
    expect(options.timeScale.tickMarkFormatter(wall(Date.UTC(2026, 10, 1, 3, 0)), 2)).toBe('1 nov')
    expect(options.localization.timeFormatter(wall(T0))).toBe('31 oct 09:00')
  })

  it('un gesto que empieza sobre el gráfico es del gráfico: no llega a la hoja', () => {
    const onSheetDrag = vi.fn()
    render(
      <div onPointerDown={onSheetDrag}>
        <CandleChart candles={candles(4)} label="Velas de SOL" />
      </div>,
    )
    fireEvent.pointerDown(screen.getByRole('img', { name: 'Velas de SOL' }))
    expect(onSheetDrag).not.toHaveBeenCalled()
  })

  it('al pasar a oscuro relee los colores y se rearma', () => {
    render(<CandleChart candles={candles(4)} label="Velas de SOL" />)
    expect(chart.created).toHaveLength(1)
    act(() => setMedia('(prefers-color-scheme: dark)', true))
    expect(chart.removed.count).toBe(1)
    expect(chart.created).toHaveLength(2)
  })
})
