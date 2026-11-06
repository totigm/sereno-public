'use client'

import { useState } from 'react'
import { newCommandId } from '@/components/posiciones/command-id'
import { useToast } from '@/components/ui/toast'
import { cancelCommand, type EnqueueResult } from '@/lib/actions/commands'

const UNSENT = 'No pude mandar el pedido. Revisá la conexión y probá de nuevo.'
const UNCANCELLED = 'No pude cancelarlo. Revisá la conexión y probá de nuevo.'

export interface CommandSender {
  /** El id del último pedido que salió de esta pantalla, para seguirlo. */
  sentId: string | null
  pending: boolean
  /** Lo manda con un id nuevo (la clave de idempotencia la genera el cliente); true si salió. */
  send: (sentMessage: string) => Promise<boolean>
  /** "Cancelar" mientras el bot no lo tomó. */
  cancel: () => Promise<void>
}

/** Un comando al bot desde un botón: id del cliente, estado de envío y toast con lo que pasó. */
export function useCommand(enqueue: (id: string) => Promise<EnqueueResult>): CommandSender {
  const toast = useToast()
  const [sentId, setSentId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const send = async (sentMessage: string) => {
    setPending(true)
    try {
      const result = await enqueue(newCommandId())
      if (!result.ok) {
        toast({ message: result.message })
        return false
      }
      setSentId(result.id)
      toast({ message: sentMessage })
      return true
    } catch {
      toast({ message: UNSENT })
      return false
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    if (sentId === null) return
    const result = await cancelCommand(sentId).catch(() => null)
    toast({ message: result === null ? UNCANCELLED : result.ok ? 'Cancelado: no se hizo nada.' : result.message })
  }

  return { sentId, pending, send, cancel }
}
