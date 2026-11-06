import { act, screen } from '@testing-library/react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Band } from '@/components/status/band'
import { setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'

// Una banda que ya está a la vista en la carga (sin conexión, error de lectura) llega
// dibujada por el servidor, que no conoce la preferencia de movimiento del sistema.

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

const band = (
  <Band show tone="quiet" role="status">
    Bot sin conexión desde las 14:32.
  </Band>
)

describe('banda de estado al hidratar', () => {
  it('con movimiento reducido hidrata igual que el servidor, sin avisos de React', async () => {
    const expectWarning = expectReducedMotionWarning()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    container.innerHTML = renderToString(band)
    document.body.append(container)
    setReducedMotion(true)

    const recoverable: unknown[] = []
    await act(async () => {
      roots.push(hydrateRoot(container, band, { onRecoverableError: (e) => recoverable.push(e) }))
    })

    expect(recoverable).toEqual([])
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    // La región viva sigue montada y con el aviso.
    expect(screen.getByRole('status')).toHaveTextContent('Bot sin conexión desde las 14:32.')
    expectWarning()
  })
})
