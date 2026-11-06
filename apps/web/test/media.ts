// jsdom no implementa `matchMedia`; este doble deja fijar por test qué consultas
// coinciden (por ejemplo `(min-width: 900px)` para simular desktop) y avisa a
// quien escucha `change`, como el navegador. Motion guarda la preferencia de
// movimiento reducido a nivel de módulo y la actualiza sólo por ese evento.

type Listener = EventListenerOrEventListenerObject

const matches = new Map<string, boolean>()
const listeners = new Map<string, Set<Listener>>()

/** Las dos formas de preguntar: Motion usa la booleana, el CSS la explícita. */
const REDUCED_MOTION_QUERIES = ['(prefers-reduced-motion)', '(prefers-reduced-motion: reduce)'] as const

function notify(query: string): void {
  const value = matches.get(query) ?? false
  const event = { type: 'change', matches: value, media: query } as MediaQueryListEvent
  for (const listener of listeners.get(query) ?? []) {
    if (typeof listener === 'function') listener(event)
    else listener.handleEvent(event)
  }
}

export function setMedia(query: string, value: boolean): void {
  matches.set(query, value)
  notify(query)
}

export function setReducedMotion(value: boolean): void {
  for (const query of REDUCED_MOTION_QUERIES) setMedia(query, value)
}

export function resetMedia(): void {
  const changed = [...matches.keys()]
  matches.clear()
  for (const query of changed) notify(query)
}

function listenersOf(query: string): Set<Listener> {
  let set = listeners.get(query)
  if (!set) {
    set = new Set()
    listeners.set(query, set)
  }
  return set
}

export function installMatchMedia(): void {
  if (typeof window === 'undefined') return
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      get matches() {
        return matches.get(query) ?? false
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => {
        listenersOf(query).add(listener)
      },
      removeEventListener: (_type: string, listener: Listener) => {
        listenersOf(query).delete(listener)
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
