import { render, screen } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SwipeToClose } from '@/components/posiciones/swipe-to-close'
import { useEntrance } from '@/components/resumen/use-entrance'
import { setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'

// La entrada de Resumen es CSS sobre el HTML del servidor: si al hidratar algo no coincide,
// React tira ese HTML, dibuja de nuevo en el cliente y la secuencia se corta.

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

/** Lo que dibuja el servidor, hidratado como en la carga inicial; junta los errores de hidratación. */
async function hydrate(ui: ReactNode, beforeHydrating = () => {}) {
  const container = document.createElement('div')
  container.innerHTML = renderToString(ui)
  document.body.append(container)
  beforeHydrating()
  const errors: unknown[] = []
  await act(async () => {
    roots.push(hydrateRoot(container, ui, { onRecoverableError: (error) => errors.push(error) }))
  })
  return { container, errors }
}

function Block() {
  const enter = useEntrance()
  return <div data-testid="bloque" {...enter(3, 'mt-8')} />
}

describe('la carga inicial de Resumen', () => {
  it('al hidratar lo que llegó del servidor, cada bloque entra en su lugar de la secuencia', async () => {
    const { container, errors } = await hydrate(<Block />)
    expect(errors).toEqual([])
    expect(container.firstElementChild?.getAttribute('style')).toContain('--step:3')
  })

  it('montado en el cliente (al volver de otra pestaña) aparece quieto', () => {
    render(<Block />)
    expect(screen.getByTestId('bloque').getAttribute('style')).toBeNull()
    expect(screen.getByTestId('bloque')).toHaveClass('mt-8')
  })

  it('con movimiento reducido, la fila de una abierta hidrata sin rehacerse y después muestra el botón fijo', async () => {
    const expectWarning = expectReducedMotionWarning()
    // El servidor no conoce la preferencia: dibuja la fila que se desliza.
    const { container, errors } = await hydrate(
      <SwipeToClose enabled onAction={() => {}}>
        <a href="/?trade=t1">Bitcoin</a>
      </SwipeToClose>,
      () => setReducedMotion(true),
    )
    expect(errors).toEqual([])
    expect(container.querySelector('.bg-loss')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cerrar ahora' })).toHaveClass('border-t')
    expectWarning()
  })
})
