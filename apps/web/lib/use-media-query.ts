'use client'

import { useSyncExternalStore } from 'react'

const noop = () => {}

function subscribe(query: string, onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return noop
  const list = window.matchMedia(query)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** `true` cuando la media query coincide; en el servidor y antes de hidratar, `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => subscribe(query, onChange),
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  )
}
