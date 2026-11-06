'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useLiveContext } from '@/lib/live/provider'

/** Entre dos lecturas de la pantalla no pasa menos que esto: lee todo Aprendizaje. */
const MIN_REFRESH_MS = 10_000

export interface RefreshWhileRunningProps {
  /** Algún replay corre o espera (el de la página o uno de la lista): hay avance que mostrar. */
  active: boolean
  /**
   * La consulta en vivo refresca (la simulación activa): se lee de nuevo cuando trae algo.
   * Fuera de ella está quieta y nadie avisa: se lee cada 10 s con la pestaña a la vista.
   */
  liveUpdates: boolean
}

/**
 * El avance de un replay ("Simulando · día 41 de 90") vive en su propia sesión, que la
 * consulta en vivo no trae: mientras alguno corre o espera, se vuelve a leer la pantalla
 * del servidor, como mucho cada 10 s. En la activa, sólo cuando el vivo trae algo nuevo
 * (latido, comandos): sin bot no hay avance y no lee nada. En un replay o una archivada,
 * con un reloj, hasta que no quede ninguno corriendo (la página pasa sola a lo aprendido).
 */
export function RefreshWhileRunning({ active, liveUpdates }: RefreshWhileRunningProps) {
  const { data } = useLiveContext()
  const router = useRouter()
  const seen = useRef(data.version)
  const lastRefresh = useRef(0)

  useEffect(() => {
    if (seen.current === data.version) return
    seen.current = data.version
    if (!active || !liveUpdates) return
    const now = Date.now()
    if (now - lastRefresh.current < MIN_REFRESH_MS) return
    lastRefresh.current = now
    router.refresh()
  }, [data.version, active, liveUpdates, router])

  useEffect(() => {
    if (!active || liveUpdates) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, MIN_REFRESH_MS)
    return () => clearInterval(timer)
  }, [active, liveUpdates, router])

  return null
}
