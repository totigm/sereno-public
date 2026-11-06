'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BotStatusChips } from '@/components/status/bot-status-chips'
import { Button } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { useToast } from '@/components/ui/toast'
import { enqueueCommand } from '@/lib/actions/commands'
import { archiveSession } from '@/lib/actions/session'
import { closeAllRowText, closeAllSentToast, closeAllText, newSimulationText, pausedToast, pauseText } from './bot-phrases'
import { CommandLine, progressOf } from './command-line'
import { glue } from './glue'
import type { SectionProps } from './section-props'
import { Panel, SettingRow, SettingsSection } from './setting-row'
import { useCommand } from './use-command'

const OFFLINE = 'El bot está sin conexión: pausar y cerrar todo vuelven cuando se conecte.'
const UNARCHIVED = 'No pude archivar la simulación. Revisá la conexión y probá de nuevo.'

export interface BotSectionProps extends SectionProps {
  sessionId: string
}

/**
 * Bot (spec §11.1 Ajustes): pausar o reanudar (un ajuste, con "Deshacer"), cerrar todo y
 * nueva simulación (destructivos, con confirmación). Sin conexión, lo que necesita al
 * bot queda deshabilitado con la explicación.
 */
export function BotSection({ editor, live, sessionId }: BotSectionProps) {
  const router = useRouter()
  const toast = useToast()
  const [confirming, setConfirming] = useState<'close_all' | 'new_simulation' | null>(null)
  const [staleMessage, setStaleMessage] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const closeAll = useCommand((id) => enqueueCommand({ id, sessionId, kind: 'close_all', payload: {} }))

  const count = live.open.length
  const { paused } = editor.config.pause
  const offline = live.offline
  const closing = closeAll.sentId !== null && ['sent', 'working'].includes(progressOf(live.commands.find((c) => c.id === closeAll.sentId)))

  const sendCloseAll = async () => {
    if (await closeAll.send(closeAllSentToast(count))) setConfirming(null)
  }

  const archive = async (closeOpen: boolean) => {
    setArchiving(true)
    try {
      const result = await archiveSession(closeOpen ? { sessionId } : { sessionId, closeOpen: false })
      if (result.ok) {
        setConfirming(null)
        // Sin simulación activa, la raíz es el primer uso: ahí se arma la nueva.
        router.push('/')
      } else if (result.reason === 'stale_mark') {
        setStaleMessage(result.message)
      } else {
        setConfirming(null)
        toast({ message: result.message })
      }
    } catch {
      toast({ message: UNARCHIVED })
    } finally {
      setArchiving(false)
    }
  }

  const closeConfirm = () => {
    setConfirming(null)
    setStaleMessage(null)
  }

  return (
    <SettingsSection title="Bot">
      <Panel>
        {/* La pausa recién guardada todavía no llegó por `/api/live`: el chip la toma de lo que se ve. */}
        <SettingRow
          label="Estado"
          {...(offline ? { description: OFFLINE } : {})}
          wrap
          control={<BotStatusChips live={{ ...live, settings: editor.config }} />}
        />

        <SettingRow
          label="Entradas nuevas"
          description={paused ? 'En pausa: no abro nuevas y sigo cuidando las abiertas.' : pauseText(count)}
          control={
            <Button variant={paused ? 'primary' : 'secondary'} disabled={offline} onClick={() => editor.setPaused(!paused, paused ? 'Bot en marcha otra vez.' : pausedToast(count))}>
              {paused ? 'Reanudar' : 'Pausar'}
            </Button>
          }
        />

        <SettingRow
          label="Posiciones abiertas"
          description={closeAllRowText(count)}
          control={
            <Button disabled={offline || count === 0 || closing} onClick={() => setConfirming('close_all')}>
              Cerrar todo
            </Button>
          }
        >
          {closeAll.sentId && (
            <CommandLine
              id={closeAll.sentId}
              commands={live.commands}
              done="Listo: cerré todo."
              expired="El bot no respondió. No cerré nada."
              onCancel={closeAll.cancel}
              onRetry={sendCloseAll}
            />
          )}
        </SettingRow>

        <SettingRow
          label="Esta simulación"
          description="La guardo para que la puedas volver a ver y arrancás otra."
          control={<Button onClick={() => setConfirming('new_simulation')}>Nueva simulación</Button>}
        />
      </Panel>

      <Confirm
        open={confirming === 'close_all'}
        onClose={closeConfirm}
        onConfirm={sendCloseAll}
        title="Cerrar todo"
        description={glue(closeAllText(live.open))}
        confirmLabel="Cerrar todo"
        pending={closeAll.pending}
      />
      <Confirm
        open={confirming === 'new_simulation'}
        onClose={closeConfirm}
        onConfirm={() => archive(staleMessage === null)}
        title="Nueva simulación"
        description={glue(staleMessage ?? newSimulationText(count))}
        confirmLabel={staleMessage === null ? 'Empezar una nueva' : 'Archivar sin cerrarlas'}
        pending={archiving}
      />
    </SettingsSection>
  )
}
