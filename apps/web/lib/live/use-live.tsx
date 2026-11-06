'use client'

import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { NOT_ALLOWED } from '../allowlist'
import { ACCESS_PATH, RETURN_PARAM } from '../return-path'
import { fetchLive, LiveAuthError } from './fetch-live'
import { liveRefetchInterval } from './interval'
import type { LivePayload } from './types'

export const liveQueryKey = (sessionId: string) => ['live', sessionId] as const

export interface UseLiveOptions {
  /** El payload que ya trajo el Server Component: la pantalla nunca arranca vacía. */
  initial?: LivePayload | undefined
  /** `false` en una sesión terminada: sin refresco periódico (spec §11.1, contexto de sesión). */
  enabled?: boolean
}

// Una sesión vencida no se arregla reintentando: se vuelve a la pantalla de acceso.
function leaveTo(error: LiveAuthError): void {
  const back = `${window.location.pathname}${window.location.search}`
  const query = error.status === 403 ? `error=${NOT_ALLOWED}` : `${RETURN_PARAM}=${encodeURIComponent(back)}`
  window.location.assign(`${ACCESS_PATH}?${query}`)
}

/**
 * Los datos en vivo de una sesión (spec §11.5): cada 5 s con la pestaña visible y el
 * bot en vivo, cada 30 s pausado o sin conexión, nada con la pestaña oculta y una
 * consulta al volver. Mientras refresca muestra lo último que tenía.
 */
export function useLive(sessionId: string, { initial, enabled = true }: UseLiveOptions = {}): UseQueryResult<LivePayload> {
  const queryClient = useQueryClient()
  const key = liveQueryKey(sessionId)
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        return await fetchLive(sessionId, queryClient.getQueryData<LivePayload>(key), { signal })
      } catch (error) {
        if (error instanceof LiveAuthError) leaveTo(error)
        throw error
      }
    },
    enabled,
    ...(initial ? { initialData: initial, initialDataUpdatedAt: initial.now } : {}),
    placeholderData: keepPreviousData,
    // El dato inicial es del servidor de recién: no hace falta pedirlo de nuevo al montar.
    staleTime: 0,
    refetchOnMount: initial === undefined,
    refetchOnWindowFocus: 'always',
    // TanStack calcula el intervalo también al renderizar en el servidor, donde no hay `document`.
    refetchInterval: (query) =>
      liveRefetchInterval(query.state.data, typeof document === 'undefined' ? 'hidden' : document.visibilityState),
    refetchIntervalInBackground: false,
    retry: (failures, error) => !(error instanceof LiveAuthError) && failures < 2,
  })
}
