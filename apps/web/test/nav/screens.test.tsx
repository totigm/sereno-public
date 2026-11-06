import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import NotFound from '@/app/not-found'
import { AjustesSkeleton } from '@/components/skeletons/ajustes-skeleton'
import { AprendizajeSkeleton } from '@/components/skeletons/aprendizaje-skeleton'
import { MonedasSkeleton } from '@/components/skeletons/monedas-skeleton'
import { PosicionesSkeleton } from '@/components/skeletons/posiciones-skeleton'
import { ResumenSkeleton } from '@/components/skeletons/resumen-skeleton'
import { ScreenError } from '@/components/status/screen-error'

describe('esqueletos', () => {
  it.each([
    ['Cargando el resumen', ResumenSkeleton],
    ['Cargando las posiciones', PosicionesSkeleton],
    ['Cargando el tablero', MonedasSkeleton],
    ['Cargando el aprendizaje', AprendizajeSkeleton],
    ['Cargando los ajustes', AjustesSkeleton],
  ])('%s: se anuncia como carga y no expone bloques vacíos', (label, Skeleton) => {
    render(<Skeleton />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent(label)
  })

  it('el tablero trae las 30 baldosas en la grilla de la spec', () => {
    const { container } = render(<MonedasSkeleton />)
    const grid = container.querySelector('.grid-cols-3')
    expect(grid).toHaveClass('max-[359px]:grid-cols-2', 'min-[600px]:grid-cols-5', 'desktop:grid-cols-6')
    expect(grid?.children).toHaveLength(30)
  })

  it('el resumen pone abiertas y capital lado a lado en desktop (1,3fr / 1fr)', () => {
    const { container } = render(<ResumenSkeleton />)
    expect(container.querySelector('.desktop\\:grid-cols-\\[1\\.3fr_1fr\\]')).not.toBeNull()
  })
})

// La pantalla deja el error en la consola (para depurar en el navegador); acá se espera.
function silenceConsoleError(): void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => spy.mockRestore())
}

describe('pantalla de error', () => {
  it('dice qué pasó, deja reintentar e ir al resumen, y muestra el código de los logs', () => {
    const retry = vi.fn()
    const error = Object.assign(new Error('boom'), { digest: 'abc123' })
    silenceConsoleError()
    render(<ScreenError error={error} retry={retry} />)
    expect(screen.getByRole('heading', { name: 'No pude mostrar esta pantalla.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Ir al resumen' })).toHaveAttribute('href', '/')
    expect(screen.getByText('Código para los logs: abc123')).toBeInTheDocument()
  })

  it('un valor que no es Error no rompe la pantalla', () => {
    silenceConsoleError()
    render(<ScreenError error="algo" retry={() => {}} />)
    expect(screen.queryByText(/Código para los logs/)).not.toBeInTheDocument()
  })
})

describe('404', () => {
  it('habla en la voz del producto y ofrece dos salidas', () => {
    render(<NotFound />)
    expect(screen.getByRole('heading', { level: 1, name: 'Esta página no existe.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ir al resumen' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Ver replays y simulaciones' })).toHaveAttribute('href', '/aprendizaje')
  })
})
