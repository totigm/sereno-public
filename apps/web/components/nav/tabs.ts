// Los cinco destinos de la spec §11.1, en el orden de la barra. La simulación activa
// vive en las rutas raíz; cualquier otra sesión, bajo `/s/[sessionId]/…`.

export type TabKey = 'resumen' | 'posiciones' | 'monedas' | 'aprendizaje' | 'ajustes'

export interface Tab {
  key: TabKey
  label: string
  /** El segmento de la ruta debajo de la base ('' es Resumen). */
  segment: string
}

export const TABS: readonly Tab[] = [
  { key: 'resumen', label: 'Resumen', segment: '' },
  { key: 'posiciones', label: 'Posiciones', segment: 'posiciones' },
  { key: 'monedas', label: 'Monedas', segment: 'monedas' },
  { key: 'aprendizaje', label: 'Aprendizaje', segment: 'aprendizaje' },
  { key: 'ajustes', label: 'Ajustes', segment: 'ajustes' },
]

/** La base de las rutas de una sesión que no es la activa (la activa usa ''). */
export function sessionBase(sessionId: string): string {
  return `/s/${sessionId}`
}

export function tabHref(base: string, tab: Tab): string {
  if (tab.segment === '') return base === '' ? '/' : base
  return `${base}/${tab.segment}`
}

/** El destino al que pertenece `pathname` dentro de `base` (subrutas incluidas), o null si es de otro lado. */
export function activeTabKey(pathname: string, base: string): TabKey | null {
  if (base !== '' && pathname !== base && !pathname.startsWith(`${base}/`)) return null
  const segment = pathname.slice(base.length).split('/')[1] ?? ''
  return TABS.find((tab) => tab.segment === segment)?.key ?? null
}
