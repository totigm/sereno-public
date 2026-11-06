import { fireEvent } from '@testing-library/react'
import { advance } from './frames'

// Gestos sintéticos para la hoja: un dedo en x fijo que sube y baja en y.

type PointerOptions = { pointerId?: number; pointerType?: 'touch' | 'mouse' }

const X = 120

const init = ({ pointerId = 1, pointerType = 'touch' }: PointerOptions, y: number, buttons: number) => ({
  pointerId,
  pointerType,
  isPrimary: true,
  button: 0,
  buttons,
  clientX: X,
  clientY: y,
})

export function press(target: Element, y: number, options: PointerOptions = {}): void {
  fireEvent.pointerDown(target, init(options, y, 1))
}

export function moveTo(target: Element, y: number, options: PointerOptions & { buttons?: number } = {}): void {
  fireEvent.pointerMove(target, init(options, y, options.buttons ?? 1))
}

export function release(target: Element, y: number, options: PointerOptions = {}): void {
  fireEvent.pointerUp(target, init(options, y, 0))
}

/** Lleva el dedo de `from` a `to` en `frames` cuadros de 16 ms (la velocidad sale de ahí). */
export async function drag(target: Element, from: number, to: number, frames: number): Promise<void> {
  for (let i = 1; i <= frames; i += 1) {
    moveTo(target, from + ((to - from) * i) / frames)
    await advance(16)
  }
}

/** Desplazamiento vertical del panel según el `transform` que escribe Motion. */
export function offsetOf(element: HTMLElement): number {
  const match = /translateY\((-?[\d.]+)px\)/.exec(element.style.transform)
  return match ? Number(match[1]) : 0
}
