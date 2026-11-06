import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Sheet } from '@/components/ui/sheet'
import { rubberband } from '@/lib/motion'
import { DESKTOP_QUERY } from '@/lib/theme'
import { advance } from '../frames'
import { setMedia, setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'
import { drag, moveTo, offsetOf, press, release } from '../pointer'

vi.hoisted(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())

// En jsdom el panel no tiene alto: el recorrido de la hoja es el alto de la ventana.
const TRAVEL = window.innerHeight

/** Padre real: `open` es suyo y `onClose` lo baja; con `reopenable`, la hoja puede pedir volver. */
function Harness({ reopenable = false }: { reopenable?: boolean }) {
  const [open, setOpen] = useState(true)
  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      {...(reopenable ? { onReopen: () => setOpen(true) } : {})}
      title="Detalle de SOL"
    >
      <p>Contenido</p>
    </Sheet>
  )
}

const dialog = () => screen.queryByRole('dialog')
const handle = () => screen.getByTestId('sheet-handle')
const content = () => screen.getByText('Contenido')

/** Monta y espera a que termine de subir. */
async function openSheet(ui: ReactElement) {
  render(ui)
  await advance(500)
}

/** Cierra con Esc y deja pasar 100 ms: la hoja queda a mitad de su salida. */
async function closeHalfway() {
  fireEvent.keyDown(document, { key: 'Escape' })
  await advance(100)
}

describe('Sheet en el celu', () => {
  it('sigue al dedo 1:1 y, soltada quieta cerca del tope, vuelve a su lugar', async () => {
    const onClose = vi.fn()
    await openSheet(
      <Sheet open onClose={onClose} title="Detalle de SOL">
        <p>Contenido</p>
      </Sheet>,
    )
    press(handle(), 100)
    await drag(handle(), 100, 200, 5)
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(100, 0)

    await advance(100)
    release(handle(), 200)
    await advance(800)
    expect(onClose).not.toHaveBeenCalled()
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(0, 0)
  })

  it('por encima del tope resiste con rubber-band', async () => {
    await openSheet(<Harness />)
    press(handle(), 400)
    await drag(handle(), 400, -200, 10)
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(rubberband(-600, TRAVEL), 0)
  })

  it('soltada pasada la mitad se cierra y se desmonta', async () => {
    await openSheet(<Harness />)
    press(handle(), 100)
    await drag(handle(), 100, 100 + TRAVEL * 0.7, 10)
    await advance(100)
    release(handle(), 100 + TRAVEL * 0.7)
    await advance(800)
    expect(dialog()).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('un tirón rápido hacia abajo la cierra aunque haya bajado poco', async () => {
    await openSheet(<Harness />)
    press(handle(), 100)
    await drag(handle(), 100, 160, 3)
    release(handle(), 160)
    await advance(800)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('si el padre ignora onClose, la hoja vuelve a su lugar en vez de quedar invisible', async () => {
    const onClose = vi.fn()
    await openSheet(
      <Sheet open onClose={onClose} title="Detalle de SOL">
        <p>Contenido</p>
      </Sheet>,
    )
    press(handle(), 100)
    await drag(handle(), 100, 100 + TRAVEL * 0.7, 10)
    release(handle(), 100 + TRAVEL * 0.7)
    await advance(1500)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(0, 0)
  })
})

describe('Sheet agarrada mientras se cierra', () => {
  it('soltada sin moverla termina de cerrarse y libera la página', async () => {
    await openSheet(<Harness />)
    await closeHalfway()
    press(handle(), 300)
    await advance(50)
    release(handle(), 300)
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('sin onReopen, aunque la suban, termina de cerrarse: el padre ya la cerró', async () => {
    await openSheet(<Harness />)
    await closeHalfway()
    press(handle(), 600)
    await drag(handle(), 600, -200, 10)
    await advance(100)
    release(handle(), -200)
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('con onReopen, subida y soltada quieta queda abierta y responde de nuevo', async () => {
    await openSheet(<Harness reopenable />)
    await closeHalfway()
    press(handle(), 600)
    await drag(handle(), 600, -200, 10)
    await advance(100)
    release(handle(), -200)
    await advance(1000)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(0, 0)

    fireEvent.keyDown(document, { key: 'Escape' })
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('con onReopen, un tirón hacia abajo la termina de cerrar', async () => {
    await openSheet(<Harness reopenable />)
    await closeHalfway()
    press(handle(), 300)
    await drag(handle(), 300, 400, 3)
    release(handle(), 400)
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('en desktop, soltada termina de cerrarse', async () => {
    setMedia(DESKTOP_QUERY, true)
    await openSheet(<Harness />)
    await closeHalfway()
    press(handle(), 300, { pointerType: 'mouse' })
    await advance(50)
    release(handle(), 300, { pointerType: 'mouse' })
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('con movimiento reducido, soltada termina de cerrarse con el fundido', async () => {
    const assertWarning = expectReducedMotionWarning()
    setReducedMotion(true)
    await openSheet(<Harness />)
    await closeHalfway()
    press(handle(), 300)
    await advance(50)
    release(handle(), 300)
    await advance(1000)
    expect(dialog()).not.toBeInTheDocument()
    assertWarning()
  })
})

describe('Sheet: arrastre desde el contenido', () => {
  it('un candidato soltado fuera de la hoja no bloquea el próximo arrastre', async () => {
    await openSheet(<Harness />)
    press(content(), 300, { pointerType: 'mouse' })
    // El botón se suelta sobre otra cosa: el pointerup no pasa por el panel.
    fireEvent.pointerUp(document.body, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })

    press(handle(), 300, { pointerId: 2 })
    for (const y of [340, 380, 400]) {
      moveTo(handle(), y, { pointerId: 2 })
      await advance(16)
    }
    expect(offsetOf(screen.getByRole('dialog'))).toBeCloseTo(100, 0)
  })

  it('pasar el mouse sin botón apretado no arrastra la hoja', async () => {
    await openSheet(<Harness />)
    press(content(), 300, { pointerType: 'mouse' })
    moveTo(content(), 400, { pointerType: 'mouse', buttons: 0 })
    await advance(16)
    moveTo(content(), 450, { pointerType: 'mouse' })
    await advance(16)
    expect(offsetOf(screen.getByRole('dialog'))).toBe(0)
  })
})
