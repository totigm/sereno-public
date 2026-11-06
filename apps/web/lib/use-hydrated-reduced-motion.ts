'use client'

import { useReducedMotion } from 'motion/react'
import { useHydrated } from './use-hydrated'

/**
 * La preferencia de movimiento reducido, pero recién después de hidratar. El servidor no
 * la conoce y dibuja la versión con movimiento: si el cliente dibujara otra cosa al
 * hidratar, React avisaría (un atributo distinto) o tiraría el HTML del servidor.
 */
export function useHydratedReducedMotion(): boolean {
  const hydrated = useHydrated()
  return useReducedMotion() === true && hydrated
}
