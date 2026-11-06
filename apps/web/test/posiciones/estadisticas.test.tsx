import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Stats } from '@/components/posiciones/stats'
import { SymbolStats } from '@/components/posiciones/symbol-stats'
import { VerdictCard } from '@/components/posiciones/verdict-card'
import { statsView, verdictView, type VerdictView } from '@/lib/queries/stats'
import { closedView, HOUR } from './helpers'
import { NOW } from '../nav/fixtures'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const DRAWDOWN = { pct: 0.023, peakAt: Date.UTC(2026, 9, 23, 15), troughAt: Date.UTC(2026, 9, 25, 15), resolution: 'minute' as const }

/** 23 cerradas: 14 ganadas de +US$ 9,50 (+1,9R) y 9 perdidas de −US$ 5,00 (−1R). */
function book() {
  return Array.from({ length: 23 }, (_, i) =>
    closedView(`c-${i}`, {
      closedAt: NOW - (i + 1) * HOUR,
      ...(i < 14 ? {} : { closeReason: 'stop', exitPrice: 122.5, pnlNet: -5, pnlGross: -4.5, rMultiple: -1 }),
    }),
  )
}

function verdictOf(patch: Partial<VerdictView> = {}): VerdictView {
  return { ...verdictView({ real: book(), shadowTrades: 0, days: 16, drawdown: DRAWDOWN, capitalInicial: 1000, equity: 1080, shadowEquity: null, seed: 't' }), ...patch }
}

describe('veredicto', () => {
  it('con 23 trades dice que todavía no se puede saber y cuánto falta: "faltan 77"', () => {
    render(<VerdictCard verdict={verdictOf()} days={16} />)
    const card = screen.getByRole('region', { name: 'Todavía no se puede saber.' })
    expect(card).toHaveTextContent('Con 23 operaciones en 16 días todavía no se puede saber si tiene ventaja; faltan 77 operaciones y 14 días.')
    expect(within(card).getByRole('progressbar', { name: 'Operaciones cerradas' })).toHaveAttribute('aria-valuenow', '23')
    expect(card).toHaveTextContent('23 de 100 · faltan 77')
    expect(card).toHaveTextContent('16 de 30 · faltan 14 días')
  })

  it('cada condición dice si se cumple con texto, no sólo con el ícono; sin sombra queda sin evaluar', () => {
    render(<VerdictCard verdict={verdictOf()} days={16} />)
    expect(screen.getByText(/Factor de beneficio de 1,3 o más/)).toHaveTextContent('Factor de beneficio de 1,3 o más: cumple')
    expect(screen.getByText(/Drawdown máximo de 15% o menos/)).toHaveTextContent(': cumple')
    expect(screen.getByText(/puntos por debajo de los pesos originales/)).toHaveTextContent(': sin evaluar')
    expect(screen.getByText('sin muestra todavía')).toBeInTheDocument()
  })

  it('con la muestra completa no muestra el avance, sólo las cuatro condiciones', () => {
    render(<VerdictCard verdict={verdictOf({ status: 'edge', reason: 'Con 140 operaciones en 45 días: ventaja positiva.', missingTrades: 0, missingDays: 0, trades: 140, shadowGapPp: 1.2 })} days={45} />)
    expect(screen.getByRole('region', { name: 'Ventaja positiva.' })).toHaveTextContent('Las cuatro condiciones')
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('+1,2 pp')).toBeInTheDocument()
  })
})

describe('estadísticas', () => {
  it('muestra las cifras del spec, el drawdown con su resolución y los costos', () => {
    render(<Stats stats={statsView(book(), DRAWDOWN)} />)
    expect(screen.getByText('Ganadas y perdidas').nextElementSibling).toHaveTextContent('14 y 9')
    expect(screen.getByText('Tasa de acierto').nextElementSibling).toHaveTextContent('60,9%')
    expect(screen.getByText('Drawdown máximo').parentElement).toHaveTextContent('medido por minuto, del 23 de octubre al 25 de octubre')
    expect(screen.getByText('Comisiones')).toBeInTheDocument()
    expect(screen.getByText('Costo medio / riesgo medio')).toBeInTheDocument()
  })

  it('por moneda: filas "SOL · 6 trades · 4 ganados · +US$ 31,20" ordenables por un segmento', () => {
    const row = (trades: number, wins: number, pnlNet: number) => ({ trades, wins, winRate: wins / trades, pnlNet })
    render(<SymbolStats bySymbol={{ SOLUSDT: row(6, 4, 31.2), ETHUSDT: row(9, 3, 12), WIFUSDT: row(2, 2, -3) }} />)
    const rows = () => screen.getAllByRole('row').slice(1)
    const coins = () => rows().map((r) => r.textContent?.split(' ·')[0])
    // En el celu se leen la primera y la última celda; las del medio son las columnas de desktop.
    const cells = within(rows()[0]!).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('SOL · 6 trades · 4 ganados')
    expect(cells.at(-1)).toHaveTextContent('· +US$ 31,20')
    expect(coins()).toEqual(['SOL', 'ETH', 'WIF'])
    fireEvent.click(screen.getByRole('radio', { name: 'Trades' }))
    expect(coins()).toEqual(['ETH', 'SOL', 'WIF'])
    fireEvent.click(screen.getByRole('radio', { name: 'Acierto' }))
    expect(coins()).toEqual(['WIF', 'SOL', 'ETH'])
  })

  it('por moneda en desktop: la unidad va en el encabezado y cada fila muestra sólo el número', () => {
    render(<SymbolStats bySymbol={{ SOLUSDT: { trades: 6, wins: 4, winRate: 4 / 6, pnlNet: 31.2 } }} />)
    expect(screen.getByRole('columnheader', { name: 'Resultado en US$' })).toBeInTheDocument()
    const [, row] = screen.getAllByRole('row')
    expect(within(within(row!).getAllByRole('cell').at(-1)!).getByText('US$')).toHaveClass('desktop:sr-only')
  })
})
