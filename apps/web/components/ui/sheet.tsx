'use client'

import clsx from 'clsx'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  usePresence,
  useReducedMotion,
  useTransform,
  type Transition,
} from 'motion/react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { trapFocus } from '@/lib/focus-trap'
import { fade, rubberband, shouldDismiss, springDefault, springGesture } from '@/lib/motion'
import { DESKTOP_QUERY } from '@/lib/theme'
import { useMediaQuery } from '@/lib/use-media-query'
import { useEscapeToClose, useModalFocus, usePageScale } from './sheet-effects'

export type SheetProps = {
  open: boolean
  onClose: () => void
  /** Texto, o un bloque como moneda + chip + resultado; su texto es el nombre accesible de la hoja. */
  title: ReactNode
  children: ReactNode
  /** Transición compartida fila → cabecera de la hoja (spec §11.3). */
  layoutId?: string
  /** Acciones fijas al pie, fuera del área con scroll. */
  footer?: ReactNode
  /**
   * Si está, una hoja agarrada mientras se cierra y soltada arriba vuelve a
   * quedar abierta: la pide de vuelta con esto y el padre pone `open` otra vez.
   * Sin él, una vez que el padre la cerró, al soltarla termina de cerrarse.
   */
  onReopen?: () => void
}

/**
 * Hoja inferior en el celu, panel centrado de 560px en desktop (≥ 900px). La
 * física es la de la spec §11.3: seguimiento 1:1, proyección de velocidad al
 * soltar, rubber-band por encima del tope, mismo camino de entrada y salida, y
 * se puede agarrar en mitad de cualquier animación.
 */
export function Sheet({ open, ...panel }: SheetProps) {
  return <AnimatePresence>{open && <SheetPanel key="sheet" {...panel} />}</AnimatePresence>
}

type PanelProps = Omit<SheetProps, 'open'>

type Controls = ReturnType<typeof animate>

type DragState = {
  pointerId: number
  startX: number
  startY: number
  /** Valor de `y` cuando empezó el arrastre: el desplazamiento se suma a él. */
  originY: number
  /** Desde el contenido el arrastre es candidato hasta pasar el umbral. */
  active: boolean
}

/** Hacia dónde va el movimiento en curso; `null` mientras la hoja está en el dedo. */
type Heading = 'open' | 'closed' | null

/** Histéresis antes de decidir que un movimiento es un arrastre y no un toque. */
const DRAG_THRESHOLD = 10
const PAGE_SCALE = 0.98
const DESKTOP_SCALE = 0.96

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function SheetPanel({ onClose, onReopen, title, children, layoutId, footer }: PanelProps) {
  const [isPresent, safeToRemove] = usePresence()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const reduced = useReducedMotion() === true
  const titleId = useId()

  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const running = useRef<Controls[]>([])
  const heading = useRef<Heading>(null)
  // Cada movimiento nuevo invalida los anteriores: `stop()` no resuelve `finished`,
  // pero por las dudas ningún final viejo decide nada.
  const generation = useRef(0)
  const travelRef = useRef(0)
  const mounted = useRef(false)
  // `usePresence` sólo da `safeToRemove` mientras sale; un final que arrancó antes lo lee de acá.
  const presentRef = useRef(isPresent)
  const removeRef = useRef(safeToRemove)
  presentRef.current = isPresent
  removeRef.current = safeToRemove

  // Desplazamiento del panel: 0 abierto, `travel` (su alto) cerrado.
  const y = useMotionValue(0)
  const opacity = useMotionValue(1)
  const scale = useMotionValue(1)
  // Progreso 0..1 según la posición: el scrim y la escala de la página siguen al dedo.
  const progress = useTransform(y, (v) => clamp01(1 - v / Math.max(travelRef.current, 1)))
  const pageScale = useTransform(progress, (p) => 1 - (1 - PAGE_SCALE) * p)
  const scrimOpacity = desktop || reduced ? opacity : progress

  const measureTravel = () => panelRef.current?.offsetHeight || window.innerHeight

  const stopAll = () => {
    generation.current += 1
    heading.current = null
    for (const controls of running.current) controls.stop()
    running.current = []
  }

  /** Arranca `moves` como el movimiento en curso; `onSettled` corre si termina sin que otro lo reemplace. */
  const runMoves = (target: Exclude<Heading, null>, moves: Controls[], onSettled: () => void) => {
    heading.current = target
    running.current = moves
    const current = generation.current
    void Promise.all(moves.map((controls) => controls.finished)).then(() => {
      if (generation.current === current) onSettled()
    })
  }

  const toOpen = (velocity: number, transition: Transition) => {
    stopAll()
    const moves = [animate(y, 0, { ...(reduced ? springDefault : transition), velocity })]
    if (reduced) moves.push(animate(opacity, 1, fade))
    else if (desktop) moves.push(animate(opacity, 1, springDefault), animate(scale, 1, springDefault))
    runMoves('open', moves, () => {
      // Se la pidió de vuelta al padre y no la reabrió: nunca queda a la vista sin estar abierta.
      if (!presentRef.current) toClosed(0, true)
    })
  }

  /** Salida por el mismo camino, desde donde esté; `viaDrag` la manda hacia abajo también en desktop. */
  const toClosed = (velocity: number, viaDrag: boolean) => {
    stopAll()
    const travel = travelRef.current
    const moves: Controls[] = []
    if (reduced) moves.push(animate(opacity, 0, fade))
    else if (desktop && !viaDrag) {
      moves.push(animate(opacity, 0, springDefault), animate(scale, DESKTOP_SCALE, springDefault))
    } else {
      moves.push(animate(y, travel, { ...springDefault, velocity }))
      if (desktop) moves.push(animate(opacity, 0, springDefault))
    }
    runMoves('closed', moves, () => {
      if (!presentRef.current) removeRef.current?.()
      // El padre ignoró `onClose`: vuelve a su lugar en vez de quedar invisible y modal.
      else toOpen(0, springDefault)
    })
  }

  useLayoutEffect(() => {
    travelRef.current = measureTravel()
    if (isPresent && !mounted.current) {
      mounted.current = true
      if (reduced) opacity.jump(0)
      else if (desktop) {
        opacity.jump(0)
        scale.jump(DESKTOP_SCALE)
      } else y.jump(travelRef.current)
    }
    // Con la hoja en el dedo decide el que la suelta; si ya va hacia donde corresponde, se la deja seguir.
    if (drag.current?.active) return
    const target = isPresent ? 'open' : 'closed'
    if (heading.current === target) return
    if (isPresent) toOpen(y.getVelocity(), springDefault)
    else toClosed(y.getVelocity(), false)
    // Sólo reacciona a la presencia: modo y movimiento reducido no cambian con la hoja abierta.
  }, [isPresent])

  useEffect(() => () => stopAll(), [])

  useModalFocus(panelRef)
  usePageScale(pageScale, !desktop && !reduced)

  // Esc cierra mientras la hoja está abierta y es la de arriba.
  useEscapeToClose(isPresent, onClose)

  // Tab no sale de la hoja mientras está abierta, aunque el foco haya quedado afuera.
  useEffect(() => {
    const panel = panelRef.current
    if (!isPresent || !panel) return
    return trapFocus(panel)
  }, [isPresent])

  // Un candidato desde el contenido no captura el puntero: si el botón se suelta
  // fuera del panel, el pointerup no pasa por acá y hay que olvidarlo igual.
  useEffect(() => {
    const forgetCandidate = (event: PointerEvent) => {
      const state = drag.current
      if (state && !state.active && state.pointerId === event.pointerId) drag.current = null
    }
    window.addEventListener('pointerup', forgetCandidate)
    window.addEventListener('pointercancel', forgetCandidate)
    return () => {
      window.removeEventListener('pointerup', forgetCandidate)
      window.removeEventListener('pointercancel', forgetCandidate)
    }
  }, [])

  // iOS: con el contenido en el tope y el dedo bajando no hay nada que scrollear;
  // se cancela el rebote nativo para que el arrastre llegue como pointer events.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onTouchMove = (event: TouchEvent) => {
      const state = drag.current
      if (!state || !event.cancelable) return
      const touch = event.touches[0]
      const atTop = (contentRef.current?.scrollTop ?? 0) <= 0
      if (state.active || (atTop && touch && touch.clientY > state.startY)) event.preventDefault()
    }
    panel.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => panel.removeEventListener('touchmove', onTouchMove)
  }, [])

  const activate = (pointerId: number) => {
    // Se puede agarrar en mitad de cualquier animación, también de la salida: arranca desde el valor actual.
    stopAll()
    travelRef.current = measureTravel()
    panelRef.current?.setPointerCapture?.(pointerId)
  }

  const beginDrag = (event: ReactPointerEvent, fromContent: boolean) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (drag.current) return
    if (fromContent && (contentRef.current?.scrollTop ?? 0) > 0) return
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originY: y.get(),
      active: !fromContent,
    }
    if (!fromContent) activate(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return
    let dy = event.clientY - state.startY
    if (!state.active) {
      // Sin botón apretado no hay arrastre posible: el candidato quedó de una pulsación perdida.
      if (event.buttons === 0) {
        drag.current = null
        return
      }
      const dx = event.clientX - state.startX
      if (Math.abs(dy) <= DRAG_THRESHOLD) return
      const vertical = Math.abs(dy) > Math.abs(dx)
      const atTop = (contentRef.current?.scrollTop ?? 0) <= 0
      if (!vertical || dy < 0 || !atTop) {
        drag.current = null
        return
      }
      // Re-anclar: la hoja no salta los 10px del umbral.
      state.active = true
      state.startY = event.clientY
      state.originY = y.get()
      activate(event.pointerId)
      dy = 0
    }
    const raw = state.originY + dy
    y.set(raw < 0 ? rubberband(raw, travelRef.current) : raw)
  }

  const takeDrag = (event: ReactPointerEvent): DragState | null => {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return null
    drag.current = null
    if (!state.active) return null
    panelRef.current?.releasePointerCapture?.(event.pointerId)
    return state
  }

  const endDrag = (event: ReactPointerEvent) => {
    if (!takeDrag(event)) return
    const velocity = y.getVelocity()
    const dismiss = shouldDismiss(y.get(), velocity, travelRef.current)
    if (presentRef.current) {
      if (dismiss) {
        toClosed(velocity, true)
        onClose()
      } else toOpen(velocity, springGesture)
      return
    }
    // Agarrada mientras se cerraba: el padre ya la cerró, sólo vuelve si él lo acepta.
    if (!dismiss && onReopen) {
      toOpen(velocity, springGesture)
      onReopen()
      return
    }
    toClosed(velocity, true)
  }

  const cancelDrag = (event: ReactPointerEvent) => {
    if (!takeDrag(event)) return
    if (presentRef.current) toOpen(0, springDefault)
    else toClosed(0, true)
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex touch-none flex-col justify-end desktop:items-center desktop:justify-center desktop:p-6">
      <motion.div
        data-testid="sheet-scrim"
        aria-hidden
        onClick={onClose}
        style={{ opacity: scrimOpacity }}
        className="absolute inset-0 bg-scrim"
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ y, scale, opacity }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        className={clsx(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-panel bg-surface outline-none',
          'desktop:max-h-[80dvh] desktop:w-[560px] desktop:rounded-panel desktop:border desktop:border-line',
        )}
      >
        {/* Asa y cabecera: desde acá se arrastra siempre. */}
        <div
          data-testid="sheet-handle"
          onPointerDown={(event) => beginDrag(event, false)}
          className="cursor-grab touch-none select-none px-5 pt-2 pb-3 active:cursor-grabbing"
        >
          <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-chip bg-line desktop:hidden" />
          <div className="flex items-start justify-between gap-4 pt-1 desktop:pt-2">
            <motion.h2
              {...(layoutId ? { layoutId } : {})}
              id={titleId}
              className="min-w-0 flex-1 text-lg leading-tight font-semibold"
            >
              {title}
            </motion.h2>
            <button
              type="button"
              onClick={onClose}
              className="pressable -mt-1.5 -mr-2 hidden h-8 items-center rounded-[8px] px-2 text-sm font-medium text-muted hover:bg-ink/6 hover:text-ink desktop:inline-flex"
            >
              Cerrar
            </button>
          </div>
        </div>
        <div
          ref={contentRef}
          onPointerDown={(event) => beginDrag(event, true)}
          style={{ touchAction: 'pan-y' }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] desktop:pb-5"
        >
          {children}
        </div>
        {footer && (
          <div className="border-t border-line px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] desktop:pb-3">
            {footer}
          </div>
        )}
        {/* Relleno bajo la hoja: al estirarla hacia arriba no asoma el scrim por debajo. */}
        {!desktop && <div aria-hidden className="absolute inset-x-0 top-full h-32 bg-surface" />}
      </motion.div>
    </div>,
    document.body,
  )
}
