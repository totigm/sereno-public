import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EquityChart, type EquityChartProps } from '@/components/charts/equity-chart'
import { EquitySection } from '@/components/resumen/equity-chart'
import type { EquityPointView } from '@/lib/queries/sql/equity'
import { NOW } from '../nav/fixtures'
import { curves, point } from './fixtures'

// La lectura de la curva (spec §11.1: "tocar y mantener muestra fecha y valor") no se
// borra cuando la consulta en vivo trae datos: con el bot en vivo eso pasa cada 5 s.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const T0 = Date.UTC(2026, 9, 30, 3, 0)
const MIN = 60_000
const POINTS = [point(T0, 1000), point(T0 + MIN, 1002), point(T0 + 2 * MIN, 1005)]

function chartProps(points: EquityPointView[], to = T0 + 2 * MIN): EquityChartProps {
  return {
    points,
    from: T0,
    to,
    tone: 'gain',
    showSaldo: false,
    showShadow: false,
    trailingGapMs: Number.POSITIVE_INFINITY,
    label: 'Curva de equity',
    formatWhen: (at) => `minuto ${(at - T0) / MIN}`,
  }
}

/** Enfoca la curva y retrocede `back` puntos desde el último. */
function readFromEnd(back: number): HTMLElement {
  const chart = screen.getByRole('group', { name: /^Curva de equity/ })
  fireEvent.focus(chart)
  for (let i = 0; i < back; i++) fireEvent.keyDown(chart, { key: 'ArrowLeft' })
  return chart
}

describe('la lectura de la curva', () => {
  it('sigue en su punto cuando llega un arreglo nuevo con los mismos puntos', () => {
    const { rerender } = render(<EquityChart {...chartProps(POINTS)} />)
    const chart = readFromEnd(1)
    expect(within(chart).getByRole('status')).toHaveTextContent('minuto 1')

    rerender(<EquityChart {...chartProps([...POINTS])} />)
    expect(within(chart).getByRole('status')).toHaveTextContent('minuto 1')
    expect(within(chart).getByRole('status')).toHaveTextContent(/1\.002,00/)
  })

  it('con el punto de ahora agregado al final, sigue en el mismo punto', () => {
    const { rerender } = render(<EquityChart {...chartProps(POINTS)} />)
    const chart = readFromEnd(1)

    rerender(<EquityChart {...chartProps([...POINTS, point(T0 + 3 * MIN, 1007)], T0 + 3 * MIN)} />)
    expect(within(chart).getByRole('status')).toHaveTextContent('minuto 1')
  })

  it('si el punto que leía ya no está, lee el más cercano al mismo momento', () => {
    const { rerender } = render(<EquityChart {...chartProps(POINTS)} />)
    const chart = readFromEnd(0)
    expect(within(chart).getByRole('status')).toHaveTextContent('minuto 2')

    rerender(<EquityChart {...chartProps([point(T0, 1000), point(T0 + 2.5 * MIN, 1006)], T0 + 2.5 * MIN)} />)
    expect(within(chart).getByRole('status')).toHaveTextContent('minuto 2.5')
  })

  it('en Resumen, cada consulta en vivo con un punto de ahora nuevo deja la lectura donde estaba', () => {
    const equity = { ranges: curves(), defaultRange: '7d' as const }
    const live = (at: number, value: number) => ({ at, equity: value, saldo: 1247.8, shadowEquity: null })
    const { rerender } = render(<EquitySection equity={equity} livePoint={live(NOW + 5_000, 1250)} past={false} now={NOW} />)
    const chart = readFromEnd(1)
    expect(within(chart).getByRole('status')).toHaveTextContent(/1\.247,80/)

    rerender(<EquitySection equity={equity} livePoint={live(NOW + 10_000, 1251)} past={false} now={NOW} />)
    expect(within(chart).getByRole('status')).toHaveTextContent(/1\.247,80/)
  })
})
