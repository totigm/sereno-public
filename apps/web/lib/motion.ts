import type { Transition } from 'motion/react'

// Reglas de movimiento de la spec §11.3: springs críticamente amortiguados por
// defecto; rebote sólo al soltar un gesto, porque ahí hay impulso real.

export const springDefault = { type: 'spring', bounce: 0, duration: 0.35 } as const satisfies Transition
export const springGesture = { type: 'spring', bounce: 0.2, duration: 0.4 } as const satisfies Transition
export const springNumber = { type: 'spring', bounce: 0, duration: 0.25 } as const satisfies Transition
export const fade = { duration: 0.15, ease: 'easeOut' } as const satisfies Transition

/** Tasa de desaceleración del scroll de iOS; con ella se proyecta dónde terminaría un gesto. */
export const DECELERATION = 0.998
/** Velocidad hacia abajo (px/s) a partir de la cual una hoja se cierra sin importar la posición. */
export const CLOSE_VELOCITY = 500
export const RUBBERBAND_CONSTANT = 0.55

/** Distancia que recorrería un objeto soltado a `velocity` px/s hasta frenar. */
export function project(velocity: number, deceleration = DECELERATION): number {
  return ((velocity / 1000) * deceleration) / (1 - deceleration)
}

/** Resistencia progresiva al pasar un borde: cuanto más lejos, menos sigue al dedo. */
export function rubberband(overshoot: number, dimension: number, constant = RUBBERBAND_CONSTANT): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/** Fracción del recorrido de una hoja que el punto proyectado tiene que pasar para cerrarla. */
export const DISMISS_FRACTION = 0.5

/**
 * Al soltar una hoja: se cierra si el punto donde frenaría pasa la mitad de su
 * recorrido o si va hacia abajo a más de 500 px/s (spec §11.3). `y` es el
 * desplazamiento actual (0 abierta, `travel` cerrada) y `velocity` en px/s.
 */
export function shouldDismiss(y: number, velocity: number, travel: number): boolean {
  return y + project(velocity) > travel * DISMISS_FRACTION || velocity > CLOSE_VELOCITY
}
