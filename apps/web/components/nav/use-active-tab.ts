'use client'

import { usePathname } from 'next/navigation'
import { useState, type MouseEvent } from 'react'
import { activeTabKey, type TabKey } from './tabs'

/**
 * La pestaña activa, con respuesta inmediata: al tocar otra, el indicador se mueve
 * en ese mismo frame en lugar de esperar a que llegue la pantalla nueva. En cuanto
 * cambia la ruta (llegó la pantalla, o se fue para atrás) manda la ruta.
 */
export function useActiveTab(base: string): { active: TabKey | null; select: (key: TabKey, event: MouseEvent) => void } {
  const pathname = usePathname()
  const [pending, setPending] = useState<TabKey | null>(null)
  const [seenPath, setSeenPath] = useState(pathname)
  if (seenPath !== pathname) {
    setSeenPath(pathname)
    setPending(null)
  }

  function select(key: TabKey, event: MouseEvent): void {
    // Abrir en otra pestaña (o un clic que no es el principal) no navega acá.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    setPending(key)
  }

  return { active: seenPath === pathname && pending !== null ? pending : activeTabKey(pathname, base), select }
}
