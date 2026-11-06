import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CapitalCard } from '@/components/resumen/capital-card'
import type { CapitalCardView } from '@/components/resumen/capital-text'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn(), releaseProtected: vi.fn() }))

function view(progress: number | null): CapitalCardView {
  return { title: 'A US$ 700 de blindar los US$ 1.000 iniciales', detail: null, progress, reinvest: 'no · siempre sobre US$ 1.000', atRisk: null }
}

describe('CapitalCard: barra de avance hacia el blindaje', () => {
  it('sin avance (ganancia ≤ 0) la barra queda vacía, sin franja verde', () => {
    render(<CapitalCard view={view(0)} pricesAt={null} release={null} />)
    expect(screen.getByRole('progressbar', { name: 'Avance hacia el blindaje' })).toHaveAttribute('aria-valuenow', '0')
    expect(screen.queryByTestId('capital-progress-fill')).toBeNull()
  })

  it('un avance chico se ve con el mínimo de 2%', () => {
    render(<CapitalCard view={view(0.005)} pricesAt={null} release={null} />)
    expect(screen.getByTestId('capital-progress-fill')).toHaveStyle({ width: '2%' })
  })

  it('el relleno sigue al avance', () => {
    render(<CapitalCard view={view(0.25)} pricesAt={null} release={null} />)
    expect(screen.getByTestId('capital-progress-fill')).toHaveStyle({ width: '25%' })
  })
})
