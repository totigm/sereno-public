import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ACTION_WIDTH, SwipeToClose } from '@/components/posiciones/swipe-to-close'
import { advance } from '../frames'
import { setReducedMotion } from '../media'
import { expectReducedMotionWarning } from '../motion-warning'

vi.hoisted(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())

// Un dedo que se mueve en x (y fija salvo que el test la cambie).
const point = (x: number, y: number, buttons: number) => ({
  pointerId: 1,
  pointerType: 'touch',
  isPrimary: true,
  button: 0,
  buttons,
  clientX: x,
  clientY: y,
})
const press = (el: Element, x: number, y = 100) => fireEvent.pointerDown(el, point(x, y, 1))
const move = (el: Element, x: number, y = 100) => fireEvent.pointerMove(el, point(x, y, 1))
const release = (el: Element, x: number, y = 100) => fireEvent.pointerUp(el, point(x, y, 0))

async function drag(el: Element, from: number, to: number, frames: number) {
  for (let i = 1; i <= frames; i += 1) {
    move(el, from + ((to - from) * i) / frames)
    await advance(16)
  }
}

/** Corrimiento horizontal que escribe Motion en el contenido. */
function offsetX(el: HTMLElement): number {
  const match = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform)
  return match ? Number(match[1]) : 0
}

function setup(props: { enabled?: boolean; disabled?: boolean } = {}) {
  const onAction = vi.fn()
  const onOpen = vi.fn()
  const ui = (disabled: boolean) => (
    <SwipeToClose enabled={props.enabled ?? true} disabled={disabled} onAction={onAction}>
      <button type="button" onClick={onOpen}>
        SOL
      </button>
    </SwipeToClose>
  )
  const { rerender } = render(ui(props.disabled ?? false))
  const content = screen.getByRole('button', { name: 'SOL' }).parentElement as HTMLElement
  /** La acción deja de estar disponible (o vuelve) con la fila montada. */
  const setDisabled = (disabled: boolean) => rerender(ui(disabled))
  return { onAction, onOpen, content, setDisabled }
}

describe('deslizar para cerrar', () => {
  it('no se mueve dentro de los 10 px de histéresis', async () => {
    const { content } = setup()
    press(content, 300)
    move(content, 292)
    await advance(16)
    expect(offsetX(content)).toBe(0)
  })

  it('pasado el umbral sigue al dedo 1:1, sin el salto de los 10 px', async () => {
    const { content } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 235, 4)
    expect(offsetX(content)).toBeCloseTo(-50, 0)
  })

  it('soltado con impulso hacia la izquierda deja "Cerrar ahora" a la vista y tocarlo pide el cierre', async () => {
    const { content, onAction, onOpen } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 180, 5)
    release(content, 180)
    await advance(800)
    expect(offsetX(content)).toBeCloseTo(-ACTION_WIDTH, 0)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ahora' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    await advance(800)
    expect(offsetX(content)).toBeCloseTo(0, 0)
  })

  it('un arrastre corto y quieto vuelve a su lugar', async () => {
    const { content } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 255, 3)
    await advance(200)
    release(content, 255)
    await advance(800)
    expect(offsetX(content)).toBeCloseTo(0, 0)
  })

  it('si el gesto arranca vertical, es scroll: la fila no se mueve', async () => {
    const { content } = setup()
    press(content, 300, 100)
    move(content, 296, 120)
    await drag(content, 296, 150, 4)
    expect(offsetX(content)).toBe(0)
  })

  it('el click que cierra un arrastre no abre la hoja, pero el toque siguiente sí', async () => {
    const { content, onOpen } = setup()
    const sol = screen.getByRole('button', { name: 'SOL' })
    press(sol, 300)
    move(sol, 285)
    await drag(sol, 285, 270, 2)
    // Quieto antes de soltar: sin impulso, vuelve a su lugar.
    await advance(200)
    release(sol, 270)
    // Un arrastre táctil puede terminar sin click: el toque siguiente no se pierde.
    await advance(800)
    press(sol, 300)
    release(sol, 300)
    fireEvent.click(sol)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(offsetX(content)).toBe(0)
  })

  it('revelada, tocar el contenido sólo la vuelve a tapar', async () => {
    const { content, onOpen } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 150, 5)
    release(content, 150)
    await advance(800)
    const sol = screen.getByRole('button', { name: 'SOL' })
    press(sol, 200)
    release(sol, 200)
    fireEvent.click(sol)
    await advance(800)
    expect(onOpen).not.toHaveBeenCalled()
    expect(offsetX(content)).toBeCloseTo(0, 0)
  })

  it('con teclado, enfocar el botón lo deja a la vista', async () => {
    const { content } = setup()
    // Tab y después el foco: así jsdom decide que es foco de teclado (`:focus-visible`).
    fireEvent.keyDown(document.body, { key: 'Tab' })
    screen.getByRole('button', { name: 'Cerrar ahora' }).focus()
    await advance(800)
    expect(offsetX(content)).toBeCloseTo(-ACTION_WIDTH, 0)
  })

  it('el foco que devuelve una hoja al cerrarse (no de teclado) no la vuelve a abrir', async () => {
    const { content } = setup()
    // Un toque y después el foco por código: no es foco de teclado.
    fireEvent.mouseDown(document.body)
    screen.getByRole('button', { name: 'Cerrar ahora' }).focus()
    await advance(800)
    expect(offsetX(content)).toBe(0)
  })

  it('sin conexión o con un cierre en curso, el gesto no arranca y el botón está deshabilitado', async () => {
    const { content } = setup({ disabled: true })
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 150, 5)
    expect(offsetX(content)).toBe(0)
    expect(screen.getByRole('button', { name: 'Cerrar ahora' })).toBeDisabled()
  })

  it('si se apaga en mitad de un gesto, al soltarlo vuelve a taparse aunque traiga impulso', async () => {
    const { content, setDisabled } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 200, 3)
    setDisabled(true)
    await drag(content, 200, 150, 2)
    release(content, 150)
    await advance(800)
    expect(offsetX(content)).toBeCloseTo(0, 0)
  })

  it('sin acciones en este contexto (replay) no hay gesto ni botón', () => {
    setup({ enabled: false })
    expect(screen.queryByRole('button', { name: 'Cerrar ahora' })).not.toBeInTheDocument()
  })

  it('con movimiento reducido no hay desplazamiento: el botón está siempre a la vista', async () => {
    const expectWarning = expectReducedMotionWarning()
    setReducedMotion(true)
    const { content, onAction } = setup()
    press(content, 300)
    move(content, 285)
    await drag(content, 285, 150, 5)
    expect(offsetX(content)).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ahora' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expectWarning()
  })
})
