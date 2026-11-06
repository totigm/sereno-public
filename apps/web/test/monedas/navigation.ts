import { useSyncExternalStore } from 'react'
import { vi } from 'vitest'

// Doble de `next/navigation` para las pantallas que reflejan estado en la URL. Next
// sincroniza `useSearchParams` y `usePathname` con `history.pushState`/`replaceState`
// nativos y con "atrás"; acá se hace lo mismo escuchando esas llamadas y `popstate`.

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

const nativePush = window.history.pushState.bind(window.history)
const nativeReplace = window.history.replaceState.bind(window.history)
window.history.pushState = (...args: Parameters<History['pushState']>) => {
  nativePush(...args)
  notify()
}
window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
  nativeReplace(...args)
  notify()
}

/** `router.refresh()`: lo que vuelve a pedir el Server Component con la URL nueva. */
export const refresh = vi.fn()

/** Deja la URL en `path` antes de un test. */
export function resetUrl(path: string): void {
  window.history.replaceState(null, '', path)
  refresh.mockClear()
}

export const navigation = {
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
  usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => '/'),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}
