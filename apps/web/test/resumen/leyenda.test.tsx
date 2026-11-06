import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EquitySection } from '@/components/resumen/equity-chart'
import type { EquityRange } from '@/lib/queries/equity-curve'
import { NOW } from '../nav/fixtures'
import { curves, point } from './fixtures'

// Saldo y Originales eran dos grises sólidos, en la línea y en la muestra del botón:
// no se distinguían. Ahora Originales va discontinuo (5 4) y Saldo sólido y fino, con el
// mismo trazo en el gráfico y en la muestra. El punteado `0 6` queda para los huecos.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const DASH = '5 4'

function equityWithShadow() {
  const base = curves()
  const ranges = Object.fromEntries(
    Object.entries(base).map(([range, c]) => [range, { ...c, points: c.points.map((p) => point(p.at, p.equity, { saldo: p.equity - 10, shadowEquity: p.equity - 30 })) }]),
  ) as typeof base
  return { ranges, defaultRange: '7d' as EquityRange }
}

function renderSection() {
  const { container } = render(<EquitySection equity={equityWithShadow()} livePoint={null} past={false} now={NOW} />)
  return container
}

describe('leyenda de Saldo y Originales', () => {
  it('las muestras de los botones se distinguen por el trazo: Originales discontinuo, Saldo sólido', () => {
    const container = renderSection()
    const saldo = container.querySelector('[data-swatch="saldo"] line')
    const shadow = container.querySelector('[data-swatch="shadow"] line')
    expect(saldo).not.toBeNull()
    expect(shadow).not.toBeNull()
    expect(shadow).toHaveAttribute('stroke-dasharray', DASH)
    expect(saldo).not.toHaveAttribute('stroke-dasharray')
    expect(screen.getByRole('button', { name: 'Originales' })).toContainElement(shadow as HTMLElement)
    expect(screen.getByRole('button', { name: 'Saldo' })).toContainElement(saldo as HTMLElement)
  })

  it('las líneas del gráfico usan el mismo trazo que su muestra', () => {
    const container = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Saldo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Originales' }))
    const shadowLine = container.querySelector('path[data-series="shadow"]')
    const saldoLine = container.querySelector('path[data-series="saldo"]')
    expect(shadowLine).toHaveAttribute('stroke-dasharray', DASH)
    expect(saldoLine).not.toHaveAttribute('stroke-dasharray')
    expect(saldoLine).toHaveAttribute('stroke-width', '1.25')
    // Mismo color de trazo en la línea y en la muestra.
    const shadowSwatch = container.querySelector('[data-swatch="shadow"] line')
    expect(shadowLine?.getAttribute('stroke')).toBe(shadowSwatch?.getAttribute('stroke'))
    // El patrón de Originales no es el de los huecos.
    expect(DASH).not.toBe('0 6')
  })
})
