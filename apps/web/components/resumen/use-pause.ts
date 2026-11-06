'use client'

import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@sereno/shared'
import { closeAllSentToast, pausedToast } from '@/components/ajustes/bot-phrases'
import { useCommand, type CommandSender } from '@/components/ajustes/use-command'
import { useToast } from '@/components/ui/toast'
import { enqueueCommand } from '@/lib/actions/commands'
import { setPause } from '@/lib/actions/settings'
import type { LivePayload } from '@/lib/live/types'

// Pausar y reanudar desde Resumen (spec §11.1): la pausa es un ajuste (toast con
// "Deshacer"); "Pausar y cerrar todo" además manda `close_all` al bot. Lo que se ve
// cambia al tocar, sin esperar a que la consulta en vivo traiga el ajuste nuevo.

const PAUSE_OFFLINE = 'El bot está sin conexión: pausar y reanudar vuelven cuando se conecte.'
const NEVER_CONNECTED = 'Pausar y reanudar se activan cuando el bot se conecte.'
const NO_SETTINGS = 'Esta simulación no tiene ajustes para pausarla.'
const FAILED = 'No pude guardar el cambio. Revisá la conexión y probá de nuevo.'
const RESUMED = 'Bot en marcha otra vez.'
const UNDONE = 'Volví al valor anterior.'

export interface PauseApi {
  /** La pausa como se ve: la de los ajustes, o la recién tocada mientras llega. */
  pause: Settings['pause'] | null
  /** Por qué no se puede ahora; null si se puede. */
  disabledReason: string | null
  setPaused: (paused: boolean) => void
  /** Pausa y manda cerrar todas las abiertas; true si salió el cierre. */
  pauseAndCloseAll: () => Promise<boolean>
  closeAll: CommandSender
}

function pauseGroup(paused: boolean): Settings['pause'] {
  return paused ? { paused: true, by: 'user', at: new Date().toISOString(), reason: null } : { paused: false, by: null, at: null, reason: null }
}

export function usePause(live: LivePayload): PauseApi {
  const toast = useToast()
  const { sessionId, settings, settingsVersion } = live
  const [override, setOverride] = useState<Settings['pause'] | null>(null)
  // La versión que dejó la última escritura de acá: "Deshacer" no espera a que llegue por la consulta en vivo.
  const written = useRef(0)
  const closeAll = useCommand((id) => enqueueCommand({ id, sessionId, kind: 'close_all', payload: {} }))

  const livePaused = settings?.pause.paused ?? null
  useEffect(() => {
    if (override !== null && livePaused === override.paused) setOverride(null)
  }, [livePaused, override])

  const disabledReason =
    settings === null || settingsVersion === null ? NO_SETTINGS : live.botStatus === null ? NEVER_CONNECTED : live.offline ? PAUSE_OFFLINE : null

  const write = async (paused: boolean, message: string | null, undoable: boolean): Promise<boolean> => {
    const expected = Math.max(settingsVersion ?? 0, written.current)
    setOverride(pauseGroup(paused))
    try {
      const result = await setPause(sessionId, paused, expected)
      if (!result.ok) {
        setOverride(null)
        toast({ message: result.message })
        return false
      }
      written.current = result.version
      if (message !== null) {
        toast(undoable ? { message, undo: () => void write(!paused, UNDONE, false) } : { message })
      }
      return true
    } catch {
      setOverride(null)
      toast({ message: FAILED })
      return false
    }
  }

  const count = live.open.length
  return {
    pause: override ?? settings?.pause ?? null,
    disabledReason,
    setPaused: (paused) => void write(paused, paused ? pausedToast(count) : RESUMED, true),
    pauseAndCloseAll: async () => {
      // Primero la pausa: que no abra otra mientras cierra éstas.
      if (!(await write(true, null, false))) return false
      return closeAll.send(`Bot pausado. ${closeAllSentToast(count)}`)
    },
    closeAll,
  }
}
