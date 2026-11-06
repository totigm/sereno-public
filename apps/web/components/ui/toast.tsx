'use client'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { fade, springDefault } from '@/lib/motion'

/** Lo que dura "Deshacer" (spec §11.1). */
export const UNDO_DURATION_MS = 6_000
const PLAIN_DURATION_MS = 3_500

export type ToastInput = {
  message: string
  /** Si está, el toast muestra "Deshacer" y dura 6 s. */
  undo?: () => void
}

type ActiveToast = ToastInput & { id: number }

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveToast | null>(null)
  const counter = useRef(0)

  const show = useCallback((toast: ToastInput) => {
    counter.current += 1
    setActive({ ...toast, id: counter.current })
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* `--shell-bottom` es el alto de la barra inferior (ver `globals.css`): el toast queda encima.
          Va sobre las hojas (z-50): un "Deshacer" disparado desde una hoja abierta tiene que verse. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[calc(1rem+max(var(--shell-bottom),env(safe-area-inset-bottom)))]">
        <AnimatePresence mode="wait">
          {active && (
            <Toast
              key={active.id}
              message={active.message}
              {...(active.undo ? { undo: active.undo } : {})}
              onDismiss={() => setActive((current) => (current?.id === active.id ? null : current))}
            />
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

/** `toast({ message, undo })` desde cualquier componente cliente. */
export function useToast(): (toast: ToastInput) => void {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast necesita un <ToastProvider> arriba')
  return show
}

export type ToastProps = ToastInput & {
  onDismiss: () => void
}

export function Toast({ message, undo, onDismiss }: ToastProps) {
  const reduced = useReducedMotion()
  const duration = undo ? UNDO_DURATION_MS : PLAIN_DURATION_MS
  const [paused, setPaused] = useState(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  // El reloj se detiene con el puntero encima: quien está por tocar "Deshacer" no pierde el toast.
  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => dismiss.current(), duration)
    return () => window.clearTimeout(timer)
  }, [paused, duration])

  const motionProps = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: fade }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 16 },
        transition: springDefault,
      }

  return (
    <motion.div
      role="status"
      aria-live="polite"
      {...motionProps}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      className="pointer-events-auto flex w-full max-w-[560px] items-center justify-between gap-4 rounded-panel bg-ink px-4 py-3 text-bg"
    >
      <span className="min-w-0 text-[0.9375rem]">{message}</span>
      {undo && (
        <button
          type="button"
          onClick={() => {
            undo()
            onDismiss()
          }}
          className="pressable shrink-0 rounded-[8px] px-2 py-1 font-semibold text-bg hover:bg-bg/10"
        >
          Deshacer
        </button>
      )}
    </motion.div>
  )
}
