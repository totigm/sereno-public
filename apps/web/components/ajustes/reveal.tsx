'use client'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { fade, springDefault } from '@/lib/motion'

/**
 * Un bloque que aparece abriendo su lugar (spring sin rebote), así lo de abajo baja en
 * vez de saltar; con movimiento reducido sólo funde. Es la respuesta a un toque: los
 * campos del modo custom, el riesgo avanzado.
 */
export function Reveal({ show, id, children }: { show: boolean; id?: string; children: ReactNode }) {
  const reduced = useReducedMotion() === true
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, height: 0 }
  const shown = reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          id={id}
          initial={hidden}
          animate={shown}
          exit={hidden}
          transition={reduced ? fade : { ...springDefault, opacity: fade }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
