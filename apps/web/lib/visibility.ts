export const RECENT_WINDOW_MS = 30_000

const MAX_TRANSITIONS = 16

type Transition = { at: number; visible: boolean }

/**
 * Historial corto de visibilidad de la pestaña. "Estuvo visible en los últimos
 * 30 s" se lee como: estaba visible hace 30 s y lo sigue estando ahora. Así una
 * ida corta a otra pestaña no cambia nada, pero al volver de una ausencia larga
 * los números no "viajan" desde un valor viejo.
 */
export class VisibilityLog {
  private transitions: Transition[] = []

  /** Estado antes de la primera transición guardada. */
  constructor(private baseline: boolean) {}

  record(visible: boolean, at: number): void {
    this.transitions.push({ at, visible })
    // La transición que se descarta pasa a ser el estado base, si no la historia cambiaría.
    if (this.transitions.length > MAX_TRANSITIONS) {
      const dropped = this.transitions.shift()
      if (dropped) this.baseline = dropped.visible
    }
  }

  visibleAt(at: number): boolean {
    let state = this.baseline
    for (const t of this.transitions) {
      if (t.at > at) break
      state = t.visible
    }
    return state
  }

  wasVisibleRecently(now: number, window = RECENT_WINDOW_MS): boolean {
    return this.visibleAt(now) && this.visibleAt(now - window)
  }
}

let shared: VisibilityLog | null = null

/** Historial del documento actual; se arma una sola vez por pestaña. */
export function documentVisibility(): VisibilityLog {
  if (shared) return shared
  const hasDocument = typeof document !== 'undefined'
  const log = new VisibilityLog(!hasDocument || document.visibilityState === 'visible')
  if (hasDocument) {
    document.addEventListener('visibilitychange', () => {
      log.record(document.visibilityState === 'visible', Date.now())
    })
  }
  shared = log
  return log
}
