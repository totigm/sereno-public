import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from '@/components/ui/sheet'
import { DESKTOP_QUERY } from '@/lib/theme'
import { setMedia } from '../media'

describe('Sheet en desktop', () => {
  beforeEach(() => {
    setMedia(DESKTOP_QUERY, true)
  })

  it('renderiza el título como nombre accesible del diálogo', () => {
    render(
      <Sheet open onClose={() => {}} title="Pausar bot">
        <p>Sigo cuidando las 3 abiertas.</p>
      </Sheet>,
    )
    expect(screen.getByRole('dialog', { name: 'Pausar bot' })).toBeInTheDocument()
    expect(screen.getByText('Sigo cuidando las 3 abiertas.')).toBeInTheDocument()
  })

  it('cierra con Esc', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Pausar bot">
        <p>Contenido</p>
      </Sheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cierra al hacer clic afuera', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Pausar bot">
        <p>Contenido</p>
      </Sheet>,
    )
    fireEvent.click(screen.getByTestId('sheet-scrim'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('el velo usa su propio token, que oscurece también en modo oscuro', () => {
    render(
      <Sheet open onClose={() => {}} title="Pausar bot">
        <p>Contenido</p>
      </Sheet>,
    )
    expect(screen.getByTestId('sheet-scrim')).toHaveClass('bg-scrim')
  })

  it('Tab no se escapa del diálogo: del último control vuelve al primero y al revés', () => {
    render(
      <Sheet open onClose={() => {}} title="Pausar bot">
        <button type="button">Pausar</button>
      </Sheet>,
    )
    const close = screen.getByRole('button', { name: 'Cerrar' })
    const pause = screen.getByRole('button', { name: 'Pausar' })

    pause.focus()
    fireEvent.keyDown(pause, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(pause).toHaveFocus()
  })

  it('con el foco afuera del diálogo, Tab lo trae adentro', () => {
    render(
      <>
        <button type="button">Detrás</button>
        <Sheet open onClose={() => {}} title="Pausar bot">
          <button type="button">Pausar</button>
        </Sheet>
      </>,
    )
    const behind = screen.getByRole('button', { name: 'Detrás', hidden: true })
    const dialog = screen.getByRole('dialog', { name: 'Pausar bot' })

    behind.focus()
    fireEvent.keyDown(behind, { key: 'Tab' })
    expect(within(dialog).getByRole('button', { name: 'Cerrar' })).toHaveFocus()

    behind.focus()
    fireEvent.keyDown(behind, { key: 'Tab', shiftKey: true })
    expect(within(dialog).getByRole('button', { name: 'Pausar' })).toHaveFocus()
  })

  it('con dos hojas abiertas, Tab queda en la de arriba', () => {
    render(
      <>
        <Sheet open onClose={() => {}} title="Posición SOL">
          <button type="button">Cerrar posición</button>
        </Sheet>
        <Sheet open onClose={() => {}} title="¿Cerrar SOL?">
          <button type="button">Sí, cerrar</button>
        </Sheet>
      </>,
    )
    const top = screen.getByRole('dialog', { name: '¿Cerrar SOL?' })
    const confirm = within(top).getByRole('button', { name: 'Sí, cerrar' })

    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(within(top).getByRole('button', { name: 'Cerrar' })).toHaveFocus()
  })

  it('con dos hojas apiladas, Esc cierra sólo la de arriba', () => {
    const closePosition = vi.fn()
    const closeConfirm = vi.fn()
    // Funciones nuevas en cada render, como las de un padre que se vuelve a renderizar.
    const stack = (confirmOpen: boolean) => (
      <>
        <Sheet open onClose={() => closePosition()} title="Posición SOL">
          <button type="button">Cerrar posición</button>
        </Sheet>
        <Sheet open={confirmOpen} onClose={() => closeConfirm()} title="¿Cerrar SOL?">
          <button type="button">Sí, cerrar</button>
        </Sheet>
      </>
    )
    const { rerender } = render(stack(false))
    rerender(stack(true))
    // La de abajo se vuelve a renderizar con otro `onClose`: sigue abajo.
    rerender(stack(true))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeConfirm).toHaveBeenCalledTimes(1)
    expect(closePosition).not.toHaveBeenCalled()

    // Cerrada la de arriba, Esc vuelve a cerrar la de abajo.
    rerender(stack(false))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closePosition).toHaveBeenCalledTimes(1)
    expect(closeConfirm).toHaveBeenCalledTimes(1)
  })

  it('cerrada, Tab vuelve a moverse libre por la página', () => {
    const { rerender } = render(
      <>
        <button type="button">Detrás</button>
        <Sheet open onClose={() => {}} title="Pausar bot">
          <button type="button">Pausar</button>
        </Sheet>
      </>,
    )
    rerender(
      <>
        <button type="button">Detrás</button>
        <Sheet open={false} onClose={() => {}} title="Pausar bot">
          <button type="button">Pausar</button>
        </Sheet>
      </>,
    )
    const behind = screen.getByRole('button', { name: 'Detrás', hidden: true })
    behind.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    behind.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(behind).toHaveFocus()
  })

  it('no renderiza nada cuando está cerrada', () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Pausar bot">
        <p>Contenido</p>
      </Sheet>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
