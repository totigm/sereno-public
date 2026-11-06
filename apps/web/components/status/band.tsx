'use client'

import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { fade, springDefault } from '@/lib/motion'
import { useHydratedReducedMotion } from '@/lib/use-hydrated-reduced-motion'

export type BandTone = 'quiet' | 'loss'

export interface BandProps {
  show: boolean
  tone: BandTone
  /** `status` para avisos (se leen sin interrumpir), `alert` para errores. */
  role: 'status' | 'alert'
  action?: ReactNode
  children: ReactNode
}

const tones: Record<BandTone, { box: string; dot: string }> = {
  quiet: { box: 'bg-surface border border-line', dot: 'bg-muted' },
  loss: { box: 'bg-loss-soft', dot: 'bg-loss' },
}

/**
 * Una banda de estado bajo la cabecera (spec §11.1, §11.4). Entra abriendo su lugar
 * con un spring sin rebote, así lo de abajo baja en vez de saltar; con movimiento
 * reducido sólo aparece con un fundido (una banda que llega del servidor ya a la vista
 * hidrata como la dibujó el servidor, que no conoce la preferencia).
 *
 * La región viva (`role`) está siempre montada, vacía mientras no hay aviso: varios
 * lectores de pantalla sólo anuncian lo que entra en una región que ya existía, y se
 * pierden una que aparece junto con su texto. Lleva sólo el texto: la acción queda
 * afuera, porque un botón que cambia de texto ("Reintentar" → pendiente) haría que
 * algunos lectores volvieran a anunciar la alerta. Por eso el texto visible de la banda
 * (que entra y sale animado) está oculto para los lectores y la región, sin caja, lo
 * repite.
 */
export function Band({ show, tone, role, action, children }: BandProps) {
  const reduced = useHydratedReducedMotion()
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, height: 0 }
  const shown = reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }

  return (
    <div>
      <div role={role} className="sr-only">
        {show ? children : null}
      </div>
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            initial={hidden}
            animate={shown}
            exit={hidden}
            transition={reduced ? fade : { ...springDefault, opacity: fade }}
            className="overflow-hidden"
          >
            <div className="pt-3">
              <div className={clsx('flex items-start gap-3 rounded-panel px-4 py-3 text-sm', tones[tone].box)}>
                <span aria-hidden className={clsx('mt-[0.4375rem] size-1.5 shrink-0 rounded-full', tones[tone].dot)} />
                <p aria-hidden className="min-w-0 flex-1 text-pretty">
                  {children}
                </p>
                {action}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
