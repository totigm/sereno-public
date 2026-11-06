'use client'

import { motion, useReducedMotion, type Transition } from 'motion/react'
import { springDefault } from '@/lib/motion'

// La curva de equity del 404: se dibuja sola, se corta en un tramo punteado (así
// marca la spec los huecos de la curva) y sigue del otro lado. El hueco es la página
// que no está. Es el único movimiento de la pantalla y ocurre una sola vez.

const BEFORE = 'M8 94 C 44 92 62 72 96 75 S 150 90 186 68 S 232 50 254 55'
const GAP = 'M254 55 C 290 61 332 42 372 44'
const AFTER = 'M372 44 C 412 46 442 31 482 35 S 552 18 592 12'
const GRID = [26, 60, 94]

// Una excepción a los springs de la spec §11.3, a propósito: el trazo no es un objeto
// que se mueve ni se interrumpe, es una pluma que dibuja. Con duración y curva fijas los
// tres tramos se encadenan en tiempos exactos, y el trazo frena suave como una mano.
const draw = (delay: number, duration: number): Transition => ({ delay, duration, ease: [0.22, 1, 0.36, 1] })

export function GapCurve({ className }: { className?: string }) {
  const still = useReducedMotion() === true
  const from = (pathLength: number) => (still ? { pathLength: 1, opacity: 1 } : { pathLength, opacity: pathLength === 0 ? 0 : 1 })
  const line = { fill: 'none', strokeWidth: 2, strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' } as const

  return (
    <svg viewBox="0 0 600 120" aria-hidden className={className}>
      {GRID.map((y) => (
        <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <motion.path d={BEFORE} stroke="var(--gain)" {...line} initial={from(0)} animate={{ pathLength: 1, opacity: 1 }} transition={draw(0.15, 0.9)} />
      <motion.path
        d={GAP}
        stroke="var(--muted)"
        {...line}
        strokeDasharray="0 9"
        initial={still ? { opacity: 1 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1, duration: 0.4 }}
      />
      <motion.path d={AFTER} stroke="var(--gain)" {...line} initial={from(0)} animate={{ pathLength: 1, opacity: 1 }} transition={draw(1.3, 0.7)} />
      <motion.circle
        cx="592"
        cy="12"
        r="4.5"
        fill="var(--gain)"
        initial={still ? { scale: 1 } : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ ...springDefault, delay: 1.9 }}
      />
    </svg>
  )
}
