'use client'

import { animate, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fade, springNumber } from '@/lib/motion'
import { shouldInterpolate } from '@/lib/number-transition'
import { documentVisibility } from '@/lib/visibility'

export type AnimatedNumberProps = {
  value: number
  format: (value: number) => string
  className?: string
}

type Controls = ReturnType<typeof animate>

/**
 * Número que viaja hasta su nuevo valor cuando el cambio es chico y alguien lo
 * está mirando; si no, cambia de golpe con un fundido (spec §11.3). Mientras
 * viaja, el texto se escribe directo en el DOM: React sólo conoce el valor
 * asentado, así un re-render del padre no pisa el número a mitad de camino.
 * Con movimiento reducido nunca viaja: siempre es el reemplazo con fundido.
 */
export function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)
  // Viaje y fundido van por separado: un viaje nuevo no corta un fundido a media opacidad.
  const travel = useRef<Controls | null>(null)
  const fadeIn = useRef<Controls | null>(null)
  const [settled, setSettled] = useState(value)
  const reducedMotion = useReducedMotion() === true
  // El formateador va por ref: un `format` inline en el padre no reinicia un viaje en curso.
  const formatRef = useRef(format)
  formatRef.current = format

  useLayoutEffect(() => {
    if (value === shown.current) return
    const node = ref.current
    travel.current?.stop()
    travel.current = null

    const from = shown.current
    const interpolate = shouldInterpolate({
      from,
      to: value,
      visibleRecently: documentVisibility().wasVisibleRecently(Date.now()),
      reducedMotion,
    })

    if (!interpolate || !node) {
      shown.current = value
      setSettled(value)
      // Con movimiento reducido también: un fundido corto de opacidad no desplaza nada (spec §11.3).
      if (node) {
        fadeIn.current?.stop()
        fadeIn.current = animate(node, { opacity: [0, 1] }, fade)
      }
      return
    }

    travel.current = animate(from, value, {
      ...springNumber,
      onUpdate: (current) => {
        shown.current = current
        node.textContent = formatRef.current(current)
      },
      onComplete: () => {
        shown.current = value
        setSettled(value)
      },
    })
  }, [value, reducedMotion])

  useEffect(
    () => () => {
      travel.current?.stop()
      fadeIn.current?.stop()
    },
    [],
  )

  return (
    <span ref={ref} className={className}>
      {format(settled)}
    </span>
  )
}
