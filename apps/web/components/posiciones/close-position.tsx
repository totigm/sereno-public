'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Confirm } from '@/components/ui/confirm'
import { useToast } from '@/components/ui/toast'
import { cancelCommand, enqueueCommand, type CancelResult, type EnqueueResult } from '@/lib/actions/commands'
import { useLiveContext } from '@/lib/live/provider'
import type { CommandView, OpenPositionView } from '@/lib/live/types'
import { newCommandId } from './command-id'
import { coinName, formatResult } from './format'

// "Cerrar ahora" (spec §11.1, §11.4): confirmación con el número adentro, el comando
// `close_position` a la cola del bot y su estado a la vista hasta que se resuelve.
// Una sola confirmación por pantalla: las filas piden el cierre con `useClosePosition`.

export type CloseStatus =
  /** La acción está escribiendo el comando. */
  | { kind: 'sending' }
  /** En la cola; mientras el bot no lo toma se puede cancelar. */
  | { kind: 'pending'; commandId: string }
  | { kind: 'claimed'; commandId: string }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string }
  /** Pasaron los 60 s sin que el bot lo tome: no se cerró. */
  | { kind: 'expired' }

export interface ClosePositionApi {
  /** Simulación activa y bot conectado. */
  available: boolean
  /** Por qué no se puede (sin conexión); null si se puede o si en este contexto no hay acciones. */
  unavailableReason: string | null
  /** Abre la confirmación para cerrar esa abierta. */
  request: (position: OpenPositionView) => void
  /** El estado del último cierre pedido de esa moneda, o null si no hay nada que mostrar. */
  statusOf: (symbol: string) => CloseStatus | null
  cancel: (symbol: string) => void
}

export const OFFLINE_REASON = 'El bot está sin conexión: no puede cerrar posiciones hasta que vuelva.'

const ClosePositionContext = createContext<ClosePositionApi | null>(null)

export function useClosePosition(): ClosePositionApi {
  const api = useContext(ClosePositionContext)
  if (!api) throw new Error('useClosePosition necesita un <ClosePositionProvider> arriba')
  return api
}

/** "Vas a cerrar SOL por +US$ 12,40": lo que vale ahora, a la marca vigente. */
export function closeSentence(position: OpenPositionView): string {
  const coin = coinName(position.symbol)
  const net = position.valuation.net
  return net === null ? `Vas a cerrar ${coin} al precio de mercado` : `Vas a cerrar ${coin} por ${formatResult(net)}`
}

type Tracked = { id: string } | { id: null }

/** Un pedido que se mandó y no tuvo respuesta: no se sabe si llegó. */
interface Unanswered {
  id: string
  symbol: string
}

const commandById = (commands: CommandView[], id: string | null) => (id === null ? undefined : commands.find((c) => c.id === id))

/** Todavía en la cola: el bot no lo tomó o lo está haciendo. */
const isQueued = (c: CommandView) => !c.expired && (c.status === 'pending' || c.status === 'claimed')

// La acción no respondió (sin red, o el servidor falló en el camino): qué pasó y qué hacer.
const sendFailed = (coin: string) => `No pude mandar el pedido de cerrar ${coin}. Revisá la conexión y probá de nuevo.`
const cancelFailed = (coin: string) => `No pude cancelar el cierre de ${coin}. Revisá la conexión y probá de nuevo.`

function statusFrom(command: CommandView | undefined, tracked: Tracked): CloseStatus | null {
  if (tracked.id === null) return { kind: 'sending' }
  // Recién encolado y todavía no llegó en la consulta en vivo.
  if (!command) return { kind: 'pending', commandId: tracked.id }
  if (command.expired) return { kind: 'expired' }
  switch (command.status) {
    case 'pending':
      return { kind: 'pending', commandId: command.id }
    case 'claimed':
      return { kind: 'claimed', commandId: command.id }
    case 'done':
      return { kind: 'done', message: command.result?.message ?? 'Listo.' }
    case 'failed':
      return { kind: 'failed', message: command.result?.message ?? 'El bot no pudo cerrarla.' }
    case 'expired':
      return { kind: 'expired' }
    case 'cancelled':
      return null
  }
}

export interface ClosePositionProviderProps {
  /** Hay acciones sobre el bot en este contexto (simulación activa). */
  enabled: boolean
  /** Sin latido: las acciones se muestran deshabilitadas con la explicación. */
  offline: boolean
  children: ReactNode
}

export function ClosePositionProvider({ enabled, offline, children }: ClosePositionProviderProps) {
  const live = useLiveContext()
  const toast = useToast()
  const [asking, setAsking] = useState<string | null>(null)
  const [tracked, setTracked] = useState<Record<string, Tracked>>({})
  const announced = useRef(new Set<string>())
  // Lo cancelado desde acá deja de verse ya, sin esperar a que la consulta en vivo lo traiga cancelado.
  const cancelled = useRef(new Set<string>())
  // Por abierta, el pedido que no tuvo respuesta mientras no aparezca en la consulta en vivo:
  // el reintento repite su id y, si había llegado, la cola no encola un segundo cierre.
  const unanswered = useRef(new Map<string, Unanswered>())
  const { data } = live
  const available = enabled && !offline

  const forget = (symbol: string) => setTracked(({ [symbol]: _, ...rest }) => rest)

  /** El cierre de esa moneda que ya está en la cola, de acá o de otra pestaña; lo cancelado acá no cuenta. */
  const queuedClose = (symbol: string) =>
    data.commands.find((c) => c.kind === 'close_position' && c.payload.symbol === symbol && isQueued(c) && !cancelled.current.has(c.id))

  const statusOf = (symbol: string): CloseStatus | null => {
    const mine = tracked[symbol]
    if (mine) return statusFrom(commandById(data.commands, mine.id), mine)
    // Un cierre pedido desde otra pantalla o pestaña: se ve mientras espera.
    const other = queuedClose(symbol)
    return other ? statusFrom(other, { id: other.id }) : null
  }

  // Un pedido sin respuesta que aparece en la consulta en vivo sí llegó: deja de repetirse y se
  // sigue como cualquiera de acá, así se ve si venció, falló o se cerró. Si se está mandando de
  // nuevo, decide la respuesta de ese envío.
  useEffect(() => {
    for (const [positionId, sent] of unanswered.current) {
      const command = commandById(data.commands, sent.id)
      if (!command || tracked[sent.symbol]?.id === null) continue
      unanswered.current.delete(positionId)
      if (command.status === 'cancelled') continue
      setTracked((t) => (t[sent.symbol] ? t : { ...t, [sent.symbol]: { id: sent.id } }))
    }
  }, [tracked, data.commands])

  // Al terminar bien, un aviso y se deja de seguir: la fila desaparece con la consulta en vivo.
  useEffect(() => {
    for (const [symbol, mine] of Object.entries(tracked)) {
      const command = commandById(data.commands, mine.id)
      if (command?.status !== 'done' || announced.current.has(command.id)) continue
      announced.current.add(command.id)
      toast({ message: command.result?.message ?? `Cerré ${coinName(symbol)}.` })
      setTracked(({ [symbol]: _, ...rest }) => rest)
    }
  }, [tracked, data.commands, toast])

  const position = asking === null ? undefined : data.open.find((p) => p.id === asking)
  const sending = position !== undefined && tracked[position.symbol]?.id === null

  /** El pedido a la cola; null si no hubo respuesta. */
  const send = async ({ id: positionId, symbol }: OpenPositionView): Promise<EnqueueResult | null> => {
    try {
      // Un id repetido no encola otro cierre. Si ya hay uno de esa moneda en la cola (llegó
      // con la confirmación abierta), el pedido es ése; si no, el que quedó sin respuesta.
      const id = queuedClose(symbol)?.id ?? unanswered.current.get(positionId)?.id ?? newCommandId()
      unanswered.current.set(positionId, { id, symbol })
      const result = await enqueueCommand({ id, sessionId: data.sessionId, kind: 'close_position', payload: { symbol } })
      unanswered.current.delete(positionId)
      return result
    } catch {
      return null
    }
  }

  const confirm = async () => {
    if (!position) return
    const { symbol } = position
    setTracked((t) => ({ ...t, [symbol]: { id: null } }))
    const result = await send(position)
    setAsking(null)
    if (result === null || !result.ok) {
      forget(symbol)
      toast({ message: result === null ? sendFailed(coinName(symbol)) : result.message })
      return
    }
    const { id } = result
    setTracked((t) => ({ ...t, [symbol]: { id } }))
    void live.refetch()
  }

  const cancel = async (symbol: string) => {
    const id = tracked[symbol]?.id ?? queuedClose(symbol)?.id
    if (!id) return
    let result: CancelResult
    try {
      result = await cancelCommand(id)
    } catch {
      toast({ message: cancelFailed(coinName(symbol)) })
      return
    }
    if (!result.ok) {
      toast({ message: result.message })
      return
    }
    cancelled.current.add(id)
    forget(symbol)
    toast({ message: `Cancelé el cierre de ${coinName(symbol)}.` })
    void live.refetch()
  }

  const api: ClosePositionApi = {
    available,
    unavailableReason: enabled && offline ? OFFLINE_REASON : null,
    request: (p) => {
      if (!available) return
      // Un reintento empieza de cero: lo vencido o fallido deja de mostrarse.
      forget(p.symbol)
      setAsking(p.id)
    },
    statusOf,
    cancel: (symbol) => void cancel(symbol),
  }

  return (
    <ClosePositionContext value={api}>
      {children}
      <Confirm
        open={position !== undefined}
        onClose={() => {
          if (!sending) setAsking(null)
        }}
        onConfirm={() => void confirm()}
        pending={sending}
        title={position ? `Cerrar ${coinName(position.symbol)} ahora` : 'Cerrar ahora'}
        description={
          position ? (
            <>
              <span className="block font-medium text-ink">{closeSentence(position)}</span>
              <span className="mt-1 block">Es lo que vale ahora: el número final depende del precio al que la cierre el bot.</span>
            </>
          ) : null
        }
        confirmLabel="Cerrar ahora"
      />
    </ClosePositionContext>
  )
}
