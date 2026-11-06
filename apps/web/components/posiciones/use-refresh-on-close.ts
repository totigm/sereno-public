'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

/**
 * Cuando una abierta desaparece de la consulta en vivo (el bot la cerró), la página
 * se vuelve a pedir: el historial, las estadísticas y la hoja abierta pasan a verla
 * cerrada sin recargar. Sólo en la simulación activa (las otras no cambian).
 */
export function useRefreshOnClose(openIds: readonly string[], enabled: boolean): void {
  const router = useRouter()
  const previous = useRef(openIds)
  const key = openIds.join('|')
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    if (enabled && before.some((id) => !openIds.includes(id))) router.refresh()
    // `key` resume la lista: un array nuevo con los mismos ids no es un cambio.
  }, [key, enabled])
}
