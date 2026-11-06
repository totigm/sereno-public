'use client'

import clsx from 'clsx'
import { useState } from 'react'
import type { ReplayParams } from '@sereno/db'
import { Button } from '@/components/ui/button'
import { useToast, type ToastInput } from '@/components/ui/toast'
import { cancelCommand, enqueueCommand, runReplay } from '@/lib/actions/commands'
import type { CommandView } from '@/lib/live/types'
import type { SessionSummary } from '@/lib/queries/aprendizaje'
import type { SessionView } from '@/lib/queries/session'
import { cancelProgress, type CancelRequest } from './replay-cancel'
import { asReplayParams, QueuedRow, SessionRow } from './replay-rows'
import { RunReplaySheet } from './run-replay-sheet'
import { Section } from './section'
import { COMPACT_ON_DESKTOP } from './touch'
import { useUrlSheet } from './use-url-sheet'

/** `?replay=nuevo` abre la hoja "Correr un replay". */
const RUN_REPLAY_PARAM = 'replay'

export interface ReplaysListProps {
  sessions: SessionSummary[]
  /** Replays pedidos que el bot todavía no tomó (comandos `run_replay` pendientes). */
  queued: CommandView[]
  /** Los últimos comandos de la simulación activa (del vivo): de ahí sale en qué quedó cada "Cancelar". */
  commands: CommandView[]
  /** Simulación activa: correr y cancelar replays. Fuera de ella la lista sólo navega. */
  canAct: boolean
  activeSessionId: string | null
  defaultCapital: number
  /**
   * Bot sin conexión: cancelar un replay que corre queda apagado (es un comando al bot);
   * correr uno nuevo queda en cola y sacar de la cola uno pedido no necesita al bot.
   */
  offline: boolean
  now: number
}

/**
 * Replays y simulaciones (spec §9, §11.1.4): los pedidos en cola, los que corren con
 * su avance y "Cancelar", y los terminados con su resumen, que abren su sesión.
 */
export function ReplaysList({ sessions, queued, commands, canAct, activeSessionId, defaultCapital, offline, now }: ReplaysListProps) {
  const sheet = useUrlSheet(RUN_REPLAY_PARAM, 'nuevo')
  const toast = useToast()
  // Pedidos saliendo (ids de comandos en cola o de replays) y, por replay, su `cancel_replay`.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [cancels, setCancels] = useState<Readonly<Record<string, CancelRequest>>>({})
  const acting = canAct && activeSessionId !== null

  const mark = (id: string, on: boolean) =>
    setSending((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const cancelSession = async (session: SessionView) => {
    if (activeSessionId === null) return
    // `now` es el reloj de la base de la última lectura: el comando se crea después.
    const at = now
    mark(session.id, true)
    const result = await enqueueCommand({ id: crypto.randomUUID(), sessionId: activeSessionId, kind: 'cancel_replay', payload: { replaySessionId: session.id } })
    mark(session.id, false)
    if (!result.ok) {
      toast({ message: result.message })
      return
    }
    setCancels((current) => ({ ...current, [session.id]: { id: result.id, at } }))
    toast({ message: 'Pedí cancelar el replay: se detiene en unos segundos.' })
  }

  const requeue = async (params: ReplayParams) => {
    if (activeSessionId === null) return
    const result = await runReplay({ id: crypto.randomUUID(), sessionId: activeSessionId, ...params })
    if (!result.ok) toast({ message: result.message })
  }

  const removeQueued = async (command: CommandView) => {
    mark(command.id, true)
    const result = await cancelCommand(command.id)
    mark(command.id, false)
    if (!result.ok) {
      toast({ message: result.message })
      return
    }
    const params = asReplayParams(command.payload)
    const done: ToastInput = { message: 'Saqué el replay de la cola.' }
    // Deshacer lo vuelve a pedir igual, con otro id (el anterior quedó cancelado).
    if (params) done.undo = () => void requeue(params)
    toast(done)
  }

  const empty = sessions.length === 0 && queued.length === 0
  return (
    <Section title="Replays y simulaciones" description="Cada uno se abre con las mismas pantallas, contado en pasado.">
      {acting && (
        <div className="panel flex flex-col gap-3 p-4 desktop:flex-row desktop:items-center desktop:justify-between">
          <p className="text-pretty">Probá la estrategia sobre los días pasados del mercado, sin tocar esta simulación.</p>
          <Button variant="primary" onClick={sheet.show} className={clsx(COMPACT_ON_DESKTOP, 'self-start desktop:self-auto')}>
            Correr un replay
          </Button>
        </div>
      )}
      {empty ? (
        <p className="text-muted">{acting ? 'Todavía no corriste ningún replay.' : 'No hay replays ni otras simulaciones.'}</p>
      ) : (
        <ul className="border-b border-line">
          {queued.map((command) => (
            <QueuedRow
              key={command.id}
              command={command}
              offline={offline}
              onRemove={acting ? () => void removeQueued(command) : null}
              busy={sending.has(command.id)}
            />
          ))}
          {sessions.map((item) => (
            <SessionRow
              key={item.session.id}
              item={item}
              now={now}
              offline={offline}
              cancel={
                acting
                  ? {
                      onCancel: () => void cancelSession(item.session),
                      sending: sending.has(item.session.id),
                      progress: cancelProgress(cancels[item.session.id], commands),
                    }
                  : null
              }
            />
          ))}
        </ul>
      )}
      {acting && (
        <RunReplaySheet open={sheet.open} onClose={sheet.hide} sessionId={activeSessionId} defaultCapital={defaultCapital} offline={offline} now={now} />
      )}
    </Section>
  )
}
