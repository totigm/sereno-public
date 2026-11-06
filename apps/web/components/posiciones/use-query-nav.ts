'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

export type ParamsPatch = Record<string, string | null>

export interface QueryNav {
  params: URLSearchParams
  /** La URL de la pantalla con esos cambios (null borra el parámetro). */
  hrefWith: (patch: ParamsPatch) => string
  /** Va a esa URL sin sumar una entrada al historial; el servidor trae los datos nuevos. */
  replace: (patch: ParamsPatch) => void
  /** Cambia la URL sin ir al servidor: para estado que ya está en la pantalla (la vista). */
  replaceShallow: (patch: ParamsPatch) => void
  /** Hay una navegación en curso: lo de antes se ve atenuado hasta que llega lo nuevo. */
  pending: boolean
}

export function applyPatch(params: URLSearchParams, patch: ParamsPatch): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** Los parámetros de Posiciones (`vista`, filtros, `pagina`, `trade`) como estado de la URL. */
export function useQueryNav(): QueryNav {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const hrefWith = (patch: ParamsPatch) => {
    const query = applyPatch(params, patch).toString()
    return query === '' ? pathname : `${pathname}?${query}`
  }

  return {
    params,
    hrefWith,
    replace: (patch) => startTransition(() => router.replace(hrefWith(patch), { scroll: false })),
    // Next sincroniza `history.replaceState` con `useSearchParams` sin pedir la página de nuevo.
    replaceShallow: (patch) => window.history.replaceState(null, '', hrefWith(patch)),
    pending,
  }
}
