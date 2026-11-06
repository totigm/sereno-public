import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CoinSummary } from '@/components/monedas/coin-summary'
import { Tile } from '@/components/monedas/tile'
import type { TileModel } from '@/components/monedas/tile-model'
import { toneOfShown } from '@/lib/format'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const NOW = Date.UTC(2026, 10, 1, 15, 0)

function tile(change24h: number): TileModel {
  return { symbol: 'SOLUSDT', name: 'SOL', markPrice: 148.3, change24h, sPrime: 0.1, state: { kind: 'ready' } }
}

function renderTile(change24h: number) {
  render(
    <ul>
      <Tile tile={tile(change24h)} theta={0.35} now={NOW} past={false} stale={false} onOpen={() => undefined} />
    </ul>,
  )
}

describe('toneOfShown: el tono sigue al texto redondeado', () => {
  it('lo que se lee "0,0%" es neutro; lo que se lee distinto de cero lleva su signo', () => {
    expect(toneOfShown(0.0003)).toBe('muted')
    expect(toneOfShown(-0.0004)).toBe('muted')
    expect(toneOfShown(0)).toBe('muted')
    expect(toneOfShown(0.0005)).toBe('gain')
    expect(toneOfShown(-0.0005)).toBe('loss')
    expect(toneOfShown(0.012)).toBe('gain')
    expect(toneOfShown(0.0003, 2)).toBe('gain')
    expect(toneOfShown(Number.NaN)).toBe('muted')
  })
})

describe('cambio de 24 h que redondea a 0,0%', () => {
  it('la baldosa lo muestra neutro, no en verde', () => {
    renderTile(0.0003)
    const change = screen.getByText('0,0%')
    expect(change).toHaveClass('text-muted')
    expect(change).not.toHaveClass('text-gain')
  })

  it('la baldosa sigue en verde con un cambio que se lee', () => {
    renderTile(0.012)
    expect(screen.getByText('+1,2%')).toHaveClass('text-gain')
  })

  it('la hoja de la moneda lo muestra neutro, no en verde', () => {
    render(<CoinSummary tile={tile(0.0003)} position={undefined} now={NOW} past={false} stale={false} marksAt={null} base="" />)
    const change = screen.getByText('0,0%')
    expect(change).toHaveClass('text-muted')
    expect(change).not.toHaveClass('text-gain')
  })
})
