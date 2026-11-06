'use client'

import clsx from 'clsx'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { AnimatedNumber } from '@/components/ui/number'
import { formatUsd } from '@/lib/format'
import type { HeadlineParts, HeadlineTone } from './headline-model'

/** La tipografía del titular de Resumen: 30 px en el celu, 40 en desktop (la Libreta). */
export const HEADLINE_TYPE = 'max-w-[15em] text-[1.875rem] leading-[1.2] font-medium tracking-[-0.02em] text-pretty desktop:text-[2.5rem]'

const TONES: Record<HeadlineTone, string> = { gain: 'text-gain', loss: 'text-loss', ink: 'text-ink' }

// "US$" y su número nunca quedan en renglones distintos.
const formatAmount = (n: number) => formatUsd(n).replace(' ', ' ')

// Un fundido cruzado sin desplazamiento: vale igual con movimiento reducido (spec §11.3).
const crossfade = { duration: 0.25, ease: 'easeOut' } as const

function Sentence({ parts }: { parts: HeadlineParts }) {
  // La frase que se va queda a la vista mientras se funde, pero ya no es el titular.
  const present = useIsPresent()
  return (
    <motion.span
      aria-hidden={present ? undefined : true}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={crossfade}
      className="col-start-1 row-start-1"
    >
      {parts.before}
      {parts.amount !== null && (
        <AnimatedNumber
          value={parts.amount}
          format={formatAmount}
          className={clsx('font-semibold', parts.stale ? 'text-muted' : TONES[parts.tone])}
        />
      )}
      {parts.after}
    </motion.span>
  )
}

/**
 * El titular de Resumen (spec §11.1): una frase con el número adentro. El número viaja
 * cuando cambia poco (`AnimatedNumber`); cuando cambia el verbo (cruzar cero, la primera
 * operación) la frase entera se reemplaza con un fundido cruzado, las dos en la misma
 * celda para que nada salte.
 */
export function Headline({ parts, className }: { parts: HeadlineParts; className?: string | undefined }) {
  return (
    <h1 className={clsx('grid', HEADLINE_TYPE, className)}>
      <AnimatePresence initial={false}>
        <Sentence key={parts.key} parts={parts} />
      </AnimatePresence>
    </h1>
  )
}
