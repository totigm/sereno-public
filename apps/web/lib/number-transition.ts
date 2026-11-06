/** Cambio relativo (sobre el valor anterior) a partir del cual un número se reemplaza en vez de interpolarse. */
export const INTERPOLATE_MAX_RATIO = 0.05

export type NumberTransitionInput = {
  from: number
  to: number
  visibleRecently: boolean
  reducedMotion: boolean
}

/**
 * Spec §11.3: interpolar sólo si el cambio es menor al 5% del valor y la pestaña
 * estuvo visible en los últimos 30 s. Cruzar cero o salir de cero tampoco se
 * interpola: el signo cambia y lo que corresponde es un fundido.
 */
export function shouldInterpolate({ from, to, visibleRecently, reducedMotion }: NumberTransitionInput): boolean {
  if (reducedMotion || !visibleRecently) return false
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return false
  if (Math.sign(from) !== Math.sign(to)) return false
  return Math.abs(to - from) / Math.abs(from) < INTERPOLATE_MAX_RATIO
}
