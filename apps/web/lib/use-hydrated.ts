'use client'

import { useSyncExternalStore } from 'react'

const noop = () => () => {}

/**
 * False en el servidor y al hidratar (vale el snapshot del servidor); true después y en todo
 * lo que se monta en el cliente. Para lo que el servidor no puede dibujar igual: las hojas
 * son portales que el servidor no dibuja, y si una se abriera al hidratar (`?trade=`,
 * `?moneda=`, `?diario=` en el enlace) React tiraría el HTML del servidor y la entrada de
 * Resumen se cortaría.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false)
}
