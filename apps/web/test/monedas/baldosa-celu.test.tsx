import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tile } from '@/components/monedas/tile'
import type { TileModel } from '@/components/monedas/tile-model'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

// A 390px el tablero va en 3 columnas: ~95px de contenido por baldosa. "ESPORTS" (~65px a
// 15px semibold) más "−12,3%" (~48px) no entran en una fila y el nombre se cortaba
// ("ESP…"). Debajo de 600px la fila de arriba pasa a columna: el nombre usa todo el ancho
// y el cambio (o el chip de la abierta) va debajo. jsdom no calcula el layout: se prueba
// la regla que lo decide.

const NOW = Date.UTC(2026, 10, 1, 15, 0)
const PHONE = ['max-[599px]:flex-col', 'max-[599px]:items-start']

function renderTile(state: TileModel['state']) {
  const tile: TileModel = { symbol: 'ESPORTSUSDT', name: 'ESPORTS', markPrice: 0.12, change24h: -0.123, sPrime: 0.1, state }
  render(
    <ul>
      <Tile tile={tile} theta={0.35} now={NOW} past={false} stale={false} onOpen={() => undefined} />
    </ul>,
  )
}

describe('baldosa en el celu: el nombre de la moneda no comparte la fila', () => {
  it('con el cambio de 24 h, nombre arriba y cambio debajo; en tablet y escritorio, en la misma fila', () => {
    renderTile({ kind: 'ready' })
    const top = screen.getByTestId('tile-top')
    expect(top).toHaveClass('flex', 'items-center', 'justify-between', ...PHONE)
    const [name, change] = Array.from(top.children)
    expect(name).toHaveTextContent('ESPORTS')
    expect(name).toHaveClass('max-w-full')
    expect(change).toHaveTextContent('−12,3%')
    expect(change).toHaveClass('shrink-0')
  })

  it('con posición, el chip también va debajo del nombre', () => {
    renderTile({ kind: 'position', side: 'short', leverage: 3, net: -1.2 })
    const top = screen.getByTestId('tile-top')
    expect(top).toHaveClass(...PHONE)
    expect(top.firstElementChild).toHaveTextContent('ESPORTS')
    expect(within(top).getByText('S 3x')).toBeInTheDocument()
  })
})
