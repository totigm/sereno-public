'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useRef, useState, type MouseEvent } from 'react'
import { applyPatch } from './use-query-nav'

export const TRADE_PARAM = 'trade'

export interface TradeParam {
  /** El trade de la hoja: el de la URL, o el recién tocado mientras la navegación trae su detalle. */
  tradeId: string | null
  /** El link a la hoja de ese trade (la URL de ahora con `?trade=<id>`): compartible y "atrás" la cierra. */
  hrefFor: (id: string) => string
  /** Para el `onClick` del link: abre la hoja al instante, sin esperar al servidor. */
  onOpen: (event: MouseEvent, id: string) => void
  close: () => void
}

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/**
 * La hoja de un trade reflejada en la URL (`?trade=<id>`): se abre al tocar con la
 * cabecera ya puesta, la navegación (push) trae el detalle del servidor, "atrás"
 * la cierra y una URL compartida la abre directo.
 */
export function useTradeParam(): TradeParam {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const fromUrl = params.get(TRADE_PARAM)
  const [selected, setSelected] = useState(fromUrl)
  const [seen, setSeen] = useState(fromUrl)
  // La hoja se abrió con un push desde acá: cerrarla vuelve atrás y no deja una entrada de más.
  const pushed = useRef(false)

  // Atrás, adelante o un link: la URL manda.
  if (fromUrl !== seen) {
    setSeen(fromUrl)
    setSelected(fromUrl)
  }

  const hrefFor = (id: string) => `${pathname}?${applyPatch(params, { [TRADE_PARAM]: id }).toString()}`

  const onOpen = (event: MouseEvent, id: string) => {
    if (!isPlainClick(event)) return
    pushed.current = true
    setSelected(id)
  }

  const close = () => {
    setSelected(null)
    if (pushed.current) {
      pushed.current = false
      router.back()
      return
    }
    const rest = applyPatch(params, { [TRADE_PARAM]: null }).toString()
    router.replace(rest === '' ? pathname : `${pathname}?${rest}`, { scroll: false })
  }

  return { tradeId: selected, hrefFor, onOpen, close }
}
