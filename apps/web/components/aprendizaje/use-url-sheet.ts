'use client'

import { useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'

export interface UrlSheet {
  open: boolean
  show: () => void
  hide: () => void
}

/** La URL actual con `param` puesto en `value` (o sacado con null), sin el origen. */
export function urlWith(param: string, value: string | null): string {
  const url = new URL(window.location.href)
  if (value === null) url.searchParams.delete(param)
  else url.searchParams.set(param, value)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Una hoja reflejada en la URL (`?replay=nuevo`): se puede compartir, se abre sola al
 * cargar con el parámetro (con cualquier valor; `value` es el que pone `show`) y
 * "atrás" la cierra. Usa `history.pushState`, que Next sincroniza con
 * `useSearchParams` sin pedir la página de nuevo: la hoja abre al toque, sin esperar
 * al servidor.
 */
export function useUrlSheet(param: string, value: string): UrlSheet {
  const fromUrl = useSearchParams().has(param)
  const [open, setOpen] = useState(fromUrl)
  const [seen, setSeen] = useState(fromUrl)
  // Abierta desde la pantalla: cerrar vuelve atrás en vez de dejar una entrada repetida.
  const pushed = useRef(false)

  // "Atrás" y "adelante" cambian la URL sin pasar por `show`/`hide`.
  if (fromUrl !== seen) {
    setSeen(fromUrl)
    setOpen(fromUrl)
  }

  const show = () => {
    setOpen(true)
    if (new URLSearchParams(window.location.search).has(param)) return
    window.history.pushState(null, '', urlWith(param, value))
    pushed.current = true
  }

  const hide = () => {
    setOpen(false)
    if (pushed.current) {
      pushed.current = false
      window.history.back()
      return
    }
    window.history.replaceState(null, '', urlWith(param, null))
  }

  return { open, show, hide }
}
