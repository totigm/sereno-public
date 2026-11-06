'use client'

import { useAnimate, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

/** Cómo late la baldosa: con escala, o sólo con color si se pidió menos movimiento. */
export type Pulse = 'beat' | 'color'

const BEAT = { duration: 0.5, ease: 'easeInOut' } as const
const GLOW = { duration: 0.8, ease: 'easeOut' } as const

/**
 * El "latido" de una baldosa cuando pasa a tener posición entre dos refrescos en vivo
 * (spec §11.3). En la carga inicial no late: la referencia arranca con el valor que
 * llegó. `scope` va en el contenedor que escala; el destello es el hijo marcado con
 * `data-pulse-glow`, que es sólo opacidad y por eso queda con movimiento reducido.
 */
export function usePulse<T extends HTMLElement>(active: boolean) {
  const [scope, animate] = useAnimate<T>()
  const reduced = useReducedMotion() === true
  const previous = useRef(active)
  const mounted = useRef(false)
  const [pulse, setPulse] = useState<Pulse | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const was = previous.current
    previous.current = active
    if (!active || was || !scope.current) return
    const kind: Pulse = reduced ? 'color' : 'beat'
    setPulse(kind)
    const moves = [animate('[data-pulse-glow]', { opacity: [0, 1, 0] }, GLOW)]
    if (kind === 'beat') moves.push(animate(scope.current, { scale: [1, 1.06, 1] }, BEAT))
    void Promise.all(moves).then(() => {
      if (mounted.current) setPulse(null)
    })
    // Sólo importa el paso a "con posición"; la preferencia de movimiento se lee en ese momento.
  }, [active])

  return { scope, pulse }
}
