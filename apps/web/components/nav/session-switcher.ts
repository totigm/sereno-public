// Fuera del módulo 'use client' del selector: las cabeceras del servidor llaman a
// `showsSwitch`, y lo que exporta un módulo 'use client' no se puede llamar desde el
// servidor.

/**
 * Qué sesión se mira y adónde lleva cada opción del selector. `paperHref` y `realHref`
 * son las bases de sus rutas ('' para la simulación en papel, `/s/<id>` para la real);
 * sin una sesión real activa, `realHref` es null y no hay selector. `other` es una
 * sesión del pasado (replay o archivada): no marca ninguna.
 */
export interface SessionSwitcher {
  paperHref: string
  realHref: string | null
  current: 'paper' | 'real' | 'other'
}

/** Hay selector sólo con una sesión real activa; donde está, reemplaza al chip de la sesión. */
export function showsSwitch(switcher: SessionSwitcher | undefined): switcher is SessionSwitcher & { realHref: string } {
  return switcher !== undefined && switcher.realHref !== null
}
