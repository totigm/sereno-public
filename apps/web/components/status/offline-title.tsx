'use client'

import { useEffect } from 'react'
import { useLiveContext } from '@/lib/live/provider'

const PREFIX = '● Sin conexión · '

/** "Sereno" ⇄ "● Sin conexión · Sereno"; nunca duplica el prefijo. */
export function withOfflinePrefix(title: string, offline: boolean): string {
  const base = title.startsWith(PREFIX) ? title.slice(PREFIX.length) : title
  return offline ? `${PREFIX}${base}` : base
}

function apply(offline: boolean): void {
  const next = withOfflinePrefix(document.title, offline)
  if (next !== document.title) document.title = next
}

/**
 * Sin conexión, la pestaña lo dice en el título (spec §11.1). El título lo escribe
 * Next en cada navegación a partir de la metadata, así que se vigila `<head>` y se
 * vuelve a poner el prefijo cada vez que cambia.
 */
export function OfflineTitle() {
  const { data } = useLiveContext()
  const offline = data.offline

  useEffect(() => {
    apply(offline)
    if (!offline) return
    const observer = new MutationObserver(() => apply(true))
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      apply(false)
    }
  }, [offline])

  return null
}
