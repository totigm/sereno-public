'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useRef } from 'react'
import { COIN_PARAM } from './coin-param'

function urlWith(pathname: string, params: URLSearchParams, symbol: string | null): string {
  const next = new URLSearchParams(params)
  if (symbol === null) next.delete(COIN_PARAM)
  else next.set(COIN_PARAM, symbol)
  const query = next.toString()
  return query === '' ? pathname : `${pathname}?${query}`
}

/**
 * La hoja de la moneda vive en la URL: se puede compartir y "atrás" la cierra.
 *
 * Abrir usa `history.pushState` nativo (Next sincroniza `useSearchParams` sin ir al
 * servidor), así la hoja aparece en el mismo cuadro del toque; después se pide la
 * página de nuevo para que llegue el gráfico de esa moneda. Cerrar vuelve atrás si la
 * abrió un toque (no deja una entrada de historial por hoja) y, si se entró con el
 * enlace, reemplaza la URL para no sacar a nadie de la app.
 */
export function useSelectedCoin() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const pushed = useRef(false)
  const selected = params.get(COIN_PARAM)

  const open = useCallback(
    (symbol: string) => {
      window.history.pushState(null, '', urlWith(pathname, params, symbol))
      pushed.current = true
      router.refresh()
    },
    [pathname, params, router],
  )

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false
      window.history.back()
      return
    }
    window.history.replaceState(null, '', urlWith(pathname, params, null))
  }, [pathname, params])

  return { selected, open, close }
}
