import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeParam } from '@/components/posiciones/use-trade-param'

const nav = vi.hoisted(() => ({
  search: '',
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/posiciones',
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(nav.search),
}))

function Harness() {
  const trade = useTradeParam()
  return (
    <>
      <a
        href={trade.hrefFor('c-1')}
        onClick={(event) => {
          // El `Link` de verdad navega solo; acá sólo importa lo que hace el hook.
          event.preventDefault()
          trade.onOpen(event, 'c-1')
        }}
      >
        BTC
      </a>
      <output>{trade.tradeId ?? 'ninguno'}</output>
      <button type="button" onClick={trade.close}>
        Cerrar hoja
      </button>
    </>
  )
}

const shown = () => screen.getByRole('status').textContent

beforeEach(() => {
  nav.search = ''
  vi.clearAllMocks()
})

describe('la hoja en la URL', () => {
  it('el link conserva los demás parámetros y suma `trade`', () => {
    nav.search = 'vista=cerradas&liquidadas=1'
    render(<Harness />)
    expect(screen.getByRole('link', { name: 'BTC' })).toHaveAttribute('href', '/posiciones?vista=cerradas&liquidadas=1&trade=c-1')
  })

  it('tocar la abre al instante; cerrarla vuelve atrás (no deja una entrada de más)', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('link', { name: 'BTC' }))
    expect(shown()).toBe('c-1')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar hoja' }))
    expect(shown()).toBe('ninguno')
    expect(nav.router.back).toHaveBeenCalledTimes(1)
    expect(nav.router.replace).not.toHaveBeenCalled()
  })

  it('con cmd o ctrl el link se abre en otra pestaña: la hoja de acá no se abre', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('link', { name: 'BTC' }), { metaKey: true })
    expect(shown()).toBe('ninguno')
  })

  it('una URL compartida la abre directo, y cerrarla saca `trade` sin sumar historial', () => {
    nav.search = 'vista=cerradas&trade=c-9'
    render(<Harness />)
    expect(shown()).toBe('c-9')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar hoja' }))
    expect(nav.router.replace).toHaveBeenCalledWith('/posiciones?vista=cerradas', { scroll: false })
    expect(nav.router.back).not.toHaveBeenCalled()
  })

  it('"atrás" del navegador manda: si la URL pierde `trade`, la hoja se cierra', () => {
    nav.search = 'trade=c-9'
    const { rerender } = render(<Harness />)
    nav.search = ''
    act(() => rerender(<Harness />))
    expect(shown()).toBe('ninguno')
  })
})
