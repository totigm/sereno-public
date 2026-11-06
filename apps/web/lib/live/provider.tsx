'use client'

import type { UseQueryResult } from '@tanstack/react-query'
import { createContext, useContext, type ReactNode } from 'react'
import type { LivePayload } from './types'
import { useLive } from './use-live'

export interface LiveState {
  /** Lo último que llegó (el payload inicial hasta la primera consulta). */
  data: LivePayload
  /** La última consulta falló: la banda "No pude leer la base. Último dato 14:32. [Reintentar]". */
  error: Error | null
  /** Cuándo llegó `data` (ms): la hora del "Último dato". */
  updatedAt: number
  isFetching: boolean
  refetch: UseQueryResult<LivePayload>['refetch']
}

const LiveContext = createContext<LiveState | null>(null)

export interface LiveProviderProps {
  sessionId: string
  initial: LivePayload
  /** `false` en replays y simulaciones archivadas: se muestra `initial` sin refrescar. */
  enabled?: boolean
  children: ReactNode
}

/** Una sola consulta en vivo por pantalla, compartida por todo lo que muestra precios. */
export function LiveProvider({ sessionId, initial, enabled = true, children }: LiveProviderProps) {
  const query = useLive(sessionId, { initial, enabled })
  const state: LiveState = {
    data: query.data ?? initial,
    error: query.error,
    updatedAt: query.dataUpdatedAt || initial.now,
    isFetching: query.isFetching,
    refetch: query.refetch,
  }
  return <LiveContext value={state}>{children}</LiveContext>
}

export function useLiveContext(): LiveState {
  const state = useContext(LiveContext)
  if (!state) throw new Error('useLiveContext necesita un <LiveProvider> arriba')
  return state
}
