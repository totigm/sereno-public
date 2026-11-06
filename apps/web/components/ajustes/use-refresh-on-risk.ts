'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { sameRisk } from './risk-fields'
import type { Versioned } from './use-settings-editor'

/**
 * Vuelve a leer la página cuando llega una versión con otro riesgo que el que trajo (el
 * bot guardó el mmr y las comisiones de la cuenta con Ajustes abierto): el origen de esos
 * valores sale de lo que leyó el servidor y, viejo, diría que los cambió Toti.
 */
export function useRefreshOnRiskChange(server: Versioned, live: Versioned | null): void {
  const router = useRouter()
  const outsideRisk = live !== null && live.version > server.version && !sameRisk(live.config.risk, server.config.risk)
  // Una vez por versión que llega: hasta que la página vuelve, el sondeo repite la misma.
  useEffect(() => {
    if (outsideRisk) router.refresh()
  }, [live?.version, outsideRisk])
}
