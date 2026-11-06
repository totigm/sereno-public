import type { LivePayload, LiveResponse } from './types'

export const LIVE_PATH = '/api/live'

/** La sesión del usuario venció (401) o su email salió de la lista (403). */
export class LiveAuthError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? 'La sesión venció.' : 'Esta cuenta no tiene acceso a Sereno.')
    this.name = 'LiveAuthError'
  }
}

export function liveUrl(sessionId: string, since?: string): string {
  const params = new URLSearchParams({ session: sessionId })
  if (since !== undefined) params.set('since', since)
  return `${LIVE_PATH}?${params.toString()}`
}

/**
 * Una consulta a `/api/live`. Con datos previos manda su versión en `since` y, si
 * nada cambió, devuelve esos mismos datos (la misma referencia: React no vuelve a
 * renderizar).
 */
export async function fetchLive(
  sessionId: string,
  previous: LivePayload | undefined,
  { fetcher = fetch, signal }: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LivePayload> {
  const response = await fetcher(liveUrl(sessionId, previous?.version), {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (response.status === 401 || response.status === 403) throw new LiveAuthError(response.status)
  if (!response.ok) throw new Error(`No pude leer los datos en vivo (${response.status}).`)
  const body = (await response.json()) as LiveResponse
  if (!('unchanged' in body)) return body
  // Sólo se pide `since` con datos previos; sin ellos, se vuelve a pedir completo.
  return previous ?? fetchLive(sessionId, undefined, { fetcher, ...(signal ? { signal } : {}) })
}
