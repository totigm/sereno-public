'use client'

import type { MotionValue } from 'motion/react'
import { useEffect, useRef, type RefObject } from 'react'

// Hojas que Esc puede cerrar, la de más arriba al final: con una confirmación abierta
// sobre una hoja, Esc cierra sólo la confirmación. Un solo listener a nivel documento.
const escapeLayers: (() => void)[] = []

function onEscape(event: KeyboardEvent): void {
  const top = escapeLayers.at(-1)
  if (event.key !== 'Escape' || !top) return
  event.preventDefault()
  top()
}

/**
 * Mientras `active`, Esc llama a `onClose` si esta hoja es la de arriba. El lugar en la
 * pila se toma al activarse y no cambia si el padre pasa otro `onClose` en cada render.
 */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!active) return
    const layer = () => onCloseRef.current()
    if (escapeLayers.length === 0) document.addEventListener('keydown', onEscape)
    escapeLayers.push(layer)
    return () => {
      const index = escapeLayers.lastIndexOf(layer)
      if (index !== -1) escapeLayers.splice(index, 1)
      if (escapeLayers.length === 0) document.removeEventListener('keydown', onEscape)
    }
  }, [active])
}

/** Bloquea el scroll de la página, enfoca el panel y, al desmontarse, devuelve el foco a donde estaba. */
export function useModalFocus(panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const previous = document.activeElement
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = bodyOverflow
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
    }
  }, [panelRef])
}

/**
 * La página de atrás (`[data-page-root]`) se achica siguiendo `scale`, con el
 * origen en el borde superior visible. Mientras tanto ese nodo tiene
 * `transform`: ver la nota en `app/layout.tsx` sobre `position: fixed`.
 */
export function usePageScale(scale: MotionValue<number>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const page = document.querySelector<HTMLElement>('[data-page-root]')
    if (!page) return
    page.style.transformOrigin = `50% ${window.scrollY}px`
    page.style.transform = `scale(${scale.get()})`
    const unsubscribe = scale.on('change', (s) => {
      page.style.transform = `scale(${s})`
    })
    return () => {
      unsubscribe()
      page.style.transform = ''
      page.style.transformOrigin = ''
    }
  }, [scale, enabled])
}
