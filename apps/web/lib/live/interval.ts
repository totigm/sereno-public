import type { LivePayload } from './types'

/** Con la pestaña visible y el bot en vivo (spec §11.5). */
export const LIVE_REFRESH_MS = 5_000
/** Con el bot pausado o sin conexión: nada cambia rápido. */
export const IDLE_REFRESH_MS = 30_000

export function isPaused(live: Pick<LivePayload, 'settings' | 'botStatus'>): boolean {
  return live.settings?.pause.paused === true || live.botStatus?.phase === 'paused'
}

/** Cada cuánto volver a consultar; `false` con la pestaña oculta (se retoma al volver). */
export function liveRefetchInterval(live: LivePayload | undefined, visibility: DocumentVisibilityState): number | false {
  if (visibility === 'hidden') return false
  if (live && (live.offline || isPaused(live))) return IDLE_REFRESH_MS
  return LIVE_REFRESH_MS
}
