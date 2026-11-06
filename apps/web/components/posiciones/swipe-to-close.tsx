'use client'

import clsx from 'clsx'
import { animate, motion, useMotionValue } from 'motion/react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { project, rubberband, springDefault, springGesture } from '@/lib/motion'
import { useHydratedReducedMotion } from '@/lib/use-hydrated-reduced-motion'

export interface SwipeToCloseProps {
  children: ReactNode
  onAction: () => void
  /** Sin gesto ni botón: en este contexto no hay acciones (replay, archivada). */
  enabled: boolean
  /** La acción existe pero no se puede ahora (sin conexión, un cierre en curso): el gesto no arranca. */
  disabled?: boolean
  label?: string
  /** La forma del contenedor (radio, borde); el contenido que se desliza va sobre superficie. */
  className?: string
  /** El fondo opaco del contenido que se desliza (tapa la acción): la superficie, salvo filas sobre el fondo de la página. */
  surfaceClassName?: string
}

/** Ancho del botón que queda a la vista: "Cerrar ahora" con aire a los costados. */
export const ACTION_WIDTH = 124
/** Histéresis antes de decidir si el gesto es horizontal (spec §11.1). */
export const SWIPE_THRESHOLD = 10

type Gesture = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  horizontal: boolean
}

/**
 * Deslizar a la izquierda revela "Cerrar ahora" (spec §11.1): 10 px de histéresis,
 * el gesto se suelta si se vuelve vertical (el scroll sigue siendo de la página),
 * seguimiento 1:1 con resistencia en los bordes, y al soltar decide la proyección
 * de la velocidad con un spring de rebote 0,2. Con movimiento reducido no hay
 * desplazamiento: el botón está siempre a la vista debajo del contenido.
 */
export function SwipeToClose({
  children,
  onAction,
  enabled,
  disabled = false,
  label = 'Cerrar ahora',
  className,
  surfaceClassName = 'bg-surface',
}: SwipeToCloseProps) {
  // El servidor no conoce la preferencia y dibuja la fila que se desliza: hasta hidratar se
  // dibuja igual, si no React descarta ese HTML y lo rehace (y corta la entrada de Resumen).
  const reduced = useHydratedReducedMotion()
  const x = useMotionValue(0)
  const [revealed, setRevealed] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  // Un arrastre termina con un click sobre el contenido: no tiene que abrir la hoja.
  const swallowClick = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  const settle = useCallback(
    (open: boolean, velocity = 0, afterGesture = false) => {
      setRevealed(open)
      animate(x, open ? -ACTION_WIDTH : 0, afterGesture ? { ...springGesture, velocity } : springDefault)
    },
    [x],
  )

  // Revelado, tocar fuera de la fila lo vuelve a tapar.
  useEffect(() => {
    if (!revealed) return
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) settle(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [revealed, settle])

  // Sin conexión o con un cierre en curso, lo revelado se tapa (también si se soltó un gesto que ya venía).
  useEffect(() => {
    if (disabled && revealed) settle(false)
  }, [disabled, revealed, settle])

  if (!enabled) return <div className={className}>{children}</div>

  if (reduced) {
    return (
      <div className={clsx('flex flex-col', className)}>
        {children}
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          className="flex h-11 items-center justify-center border-t border-line text-sm font-semibold text-loss disabled:text-muted"
        >
          {label}
        </button>
      </div>
    )
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Un arrastre táctil no siempre termina en click: lo de antes no cuenta para este toque.
    swallowClick.current = false
    if (disabled || gesture.current || (event.pointerType === 'mouse' && event.button !== 0)) return
    // Se puede agarrar en mitad de la animación: arranca desde donde está.
    x.stop()
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: x.get(), horizontal: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointerId !== event.pointerId) return
    let dx = event.clientX - g.startX
    if (!g.horizontal) {
      const dy = event.clientY - g.startY
      if (Math.abs(dx) <= SWIPE_THRESHOLD && Math.abs(dy) <= SWIPE_THRESHOLD) return
      if (Math.abs(dy) >= Math.abs(dx)) {
        gesture.current = null
        return
      }
      // Re-anclar: la fila no salta los 10 px del umbral.
      g.horizontal = true
      g.startX = event.clientX
      g.originX = x.get()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dx = 0
    }
    swallowClick.current = true
    const raw = g.originX + dx
    if (raw > 0) x.set(rubberband(raw, ACTION_WIDTH))
    else if (raw < -ACTION_WIDTH) x.set(-ACTION_WIDTH + rubberband(raw + ACTION_WIDTH, ACTION_WIDTH))
    else x.set(raw)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointerId !== event.pointerId) return
    gesture.current = null
    if (!g.horizontal) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const velocity = x.getVelocity()
    settle(x.get() + project(velocity) < -ACTION_WIDTH / 2, velocity, true)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointerId !== event.pointerId) return
    gesture.current = null
    if (g.horizontal) settle(revealed)
  }

  const onClickCapture = (event: ReactMouseEvent) => {
    // Revelado, un toque en el contenido sólo lo vuelve a tapar.
    if (!swallowClick.current && !revealed) return
    event.preventDefault()
    event.stopPropagation()
    if (!swallowClick.current) settle(false)
    swallowClick.current = false
  }

  return (
    <div
      ref={root}
      onBlur={(event) => {
        if (revealed && !event.currentTarget.contains(event.relatedTarget)) settle(false)
      }}
      className={clsx('relative overflow-hidden', className)}
    >
      <div className="absolute inset-y-0 right-0 flex bg-loss" style={{ width: ACTION_WIDTH }}>
        {/* Con teclado se llega igual: al enfocarlo, la fila se corre y lo deja a la vista. Sólo
            con foco de teclado: el foco que devuelve una hoja al cerrarse no la vuelve a abrir. */}
        <button
          type="button"
          disabled={disabled}
          onFocus={(event) => {
            if (!revealed && event.currentTarget.matches(':focus-visible')) settle(true)
          }}
          onClick={() => {
            settle(false)
            onAction()
          }}
          className="flex-1 px-3 text-sm font-semibold text-surface dark:text-bg"
        >
          {label}
        </button>
      </div>
      <motion.div
        style={{ x, touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={onClickCapture}
        // Con mouse, arrastrar un link arranca el drag nativo y cancela el gesto.
        onDragStartCapture={(event) => event.preventDefault()}
        className={clsx('relative', surfaceClassName)}
      >
        {children}
      </motion.div>
    </div>
  )
}
