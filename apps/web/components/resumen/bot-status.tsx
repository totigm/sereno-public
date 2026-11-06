'use client'

import { useId, useState } from 'react'
import { CommandLine } from '@/components/ajustes/command-line'
import { BotStatusChips } from '@/components/status/bot-status-chips'
import { Button } from '@/components/ui/button'
import { isPausedByShield } from '@/lib/derive'
import type { LivePayload } from '@/lib/live/types'
import { PauseSheet } from './pause-sheet'
import { Section } from './section'
import { usePause } from './use-pause'

export interface BotStatusProps {
  live: LivePayload
  className?: string | undefined
}

// Pausado por el blindaje, reanudar sólo sirve si mientras tanto quedó ganancia para operar
// (las abiertas cerraron bien); si no, el bot se vuelve a pausar en el ciclo siguiente.
const SHIELD_RESUME = 'Si lo reanudás sin ganancia para operar, se vuelve a pausar: para que siga, volvé a usar el capital blindado.'

/**
 * "Estado del bot" (spec §11.1): los chips con su frase y "Pausar" / "Reanudar". Sin
 * abiertas, pausar es directo (con "Deshacer"); con abiertas, una hoja pregunta qué
 * hacer con ellas. Sin conexión, el botón queda deshabilitado con la explicación.
 * Pausado por el blindaje, "Reanudar" queda en segundo plano: la acción es la de "Tu capital".
 */
export function BotStatus({ live, className }: BotStatusProps) {
  const pause = usePause(live)
  const [asking, setAsking] = useState(false)
  const noteId = useId()
  const paused = pause.pause?.paused === true
  const disabled = pause.disabledReason !== null
  const count = live.open.length

  const onPress = () => {
    if (paused) pause.setPaused(false)
    else if (count === 0) pause.setPaused(true)
    else setAsking(true)
  }

  const shown = live.settings && pause.pause ? { ...live, settings: { ...live.settings, pause: pause.pause } } : live
  const byShield = isPausedByShield(shown)
  const note = pause.disabledReason ?? (byShield ? SHIELD_RESUME : null)

  return (
    <Section title="Estado del bot" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <BotStatusChips live={shown} className="min-w-0" />
        <Button
          variant={paused && !byShield ? 'primary' : 'secondary'}
          size="sm"
          disabled={disabled}
          onClick={onPress}
          aria-describedby={note === null ? undefined : noteId}
          className="shrink-0"
        >
          {paused ? 'Reanudar' : 'Pausar'}
        </Button>
      </div>
      {note && (
        <p id={noteId} className="text-sm text-pretty text-muted">
          {note}
        </p>
      )}
      {pause.closeAll.sentId && (
        <CommandLine
          id={pause.closeAll.sentId}
          commands={live.commands}
          done="Listo: cerré todo."
          expired="El bot no respondió. No cerré nada."
          onCancel={pause.closeAll.cancel}
        />
      )}
      <PauseSheet
        open={asking}
        onClose={() => setAsking(false)}
        openPositions={live.open}
        closing={pause.closeAll.pending}
        onPause={() => {
          setAsking(false)
          pause.setPaused(true)
        }}
        onPauseAndCloseAll={async () => {
          if (await pause.pauseAndCloseAll()) setAsking(false)
        }}
      />
    </Section>
  )
}
