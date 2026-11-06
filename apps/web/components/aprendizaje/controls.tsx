'use client'

import { useId, useState } from 'react'
import { Toggle } from '@/components/ui/toggle'
import { useToast } from '@/components/ui/toast'
import { updateSettings } from '@/lib/actions/settings'
import { DEFAULT_SETTINGS } from '@/lib/format'
import { useLiveContext } from '@/lib/live/provider'
import type { CommandView } from '@/lib/live/types'
import { OfflineNote } from './offline-note'
import { ResetLearning } from './reset-learning'
import { Section } from './section'

export interface ControlsProps {
  sessionId: string
  /** Congelado por el estado guardado (no por Ajustes): no se descongela desde acá. */
  frozenByState: boolean
  closedTrades: number
  /**
   * Bot sin conexión. Congelar es un ajuste y se guarda igual: el bot lo toma al volver
   * (spec §10). Reiniciar es un comando y queda apagado (spec §11.1).
   */
  offline: boolean
}

/** Sin bot, antes de tocarlo: congelar es un ajuste y se puede igual. */
const OFFLINE_SETTING_NOTE = 'El bot está sin conexión: si lo cambiás, queda guardado y lo toma cuando vuelva.'

/** "enviado al bot… ✓ aplicado" de un ajuste (spec §11.4). */
function settingStatus(saved: number | null, applied: number | null, offline: boolean): string | null {
  if (saved === null) return null
  if (offline) return 'Guardado · el bot lo toma cuando vuelva'
  return applied !== null && applied >= saved ? '✓ Aplicado' : 'Enviado al bot…'
}

/** El estado del comando de reinicio, con lo que contestó el bot. */
export function resetCommandStatus(command: CommandView | undefined, offline: boolean): string | null {
  if (!command) return null
  switch (command.status) {
    case 'pending':
      return offline ? 'En cola · el bot lo toma cuando vuelva' : 'Enviado al bot…'
    case 'claimed':
      return 'Reiniciando…'
    case 'done':
      return `✓ ${command.result?.message ?? 'Reinicié el aprendizaje.'}`
    case 'failed':
    case 'expired':
      return command.result?.message ?? 'El bot no pudo reiniciar el aprendizaje. Probá de nuevo.'
    case 'cancelled':
      return null
  }
}

/**
 * Controles del aprendizaje (spec §8, §11.1): congelar es un ajuste (toast con
 * "Deshacer"); reiniciar es destructivo (confirmación). Sólo en la simulación activa.
 */
export function Controls({ sessionId, frozenByState, closedTrades, offline }: ControlsProps) {
  const { data } = useLiveContext()
  const toast = useToast()
  const learning = data.settings?.learning ?? DEFAULT_SETTINGS.learning
  // La versión que dejó la última escritura propia: el vivo puede venir un ciclo atrasado.
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [resetId, setResetId] = useState<string | null>(null)
  const offlineNoteId = useId()

  const liveVersion = data.settingsVersion ?? 0
  const caughtUp = savedVersion === null || liveVersion >= savedVersion
  const frozen = (caughtUp ? null : optimistic) ?? (learning.frozen || frozenByState)

  const write = async (next: boolean, expected: number): Promise<number | null> => {
    setBusy(true)
    setOptimistic(next)
    const result = await updateSettings(sessionId, { learning: { ...learning, frozen: next } }, expected)
    setBusy(false)
    if (!result.ok) {
      setOptimistic(null)
      toast({ message: result.message })
      return null
    }
    setSavedVersion(result.version)
    return result.version
  }

  const change = async (next: boolean) => {
    const version = await write(next, Math.max(liveVersion, savedVersion ?? 0))
    if (version === null) return
    toast({
      message: next ? 'Congelé el aprendizaje.' : 'Descongelé el aprendizaje.',
      // Deshacer escribe el valor anterior sobre la versión que acaba de quedar (spec §11.1).
      undo: () => void write(!next, version),
    })
  }

  const status =
    settingStatus(savedVersion, data.botStatus?.settingsVersionApplied ?? null, offline) ?? (offline && !frozenByState ? OFFLINE_SETTING_NOTE : null)
  const reset = resetCommandStatus(
    data.commands.find((c) => c.id === resetId),
    offline,
  )

  return (
    <Section title="Controles">
      <div className="panel flex flex-col divide-y divide-line">
        <div className="flex flex-col gap-1 p-4">
          <Toggle
            checked={frozen}
            onChange={(next) => void change(next)}
            disabled={busy || frozenByState}
            label="Congelar aprendizaje"
            description={
              frozenByState
                ? 'Quedó congelado en el estado guardado del bot: se descongela con un reinicio.'
                : frozen
                  ? 'No cambio pesos, confianza ni parámetros hasta que lo descongeles.'
                  : 'Sigo aprendiendo de cada trade cerrado.'
            }
          />
          {status && (
            <p role="status" className="text-sm text-muted">
              {status}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-medium">Reiniciar aprendizaje</p>
              <p className="text-sm text-pretty text-muted">Pesos, confianza y parámetros vuelven a los de fábrica. El diario queda.</p>
            </div>
            <ResetLearning
              sessionId={sessionId}
              closedTrades={closedTrades}
              label="Reiniciar…"
              offline={offline}
              offlineNoteId={offlineNoteId}
              className="shrink-0"
              onQueued={setResetId}
            />
          </div>
          {offline && <OfflineNote id={offlineNoteId} verb="reiniciar" />}
          {reset && (
            <p role="status" className="text-sm text-muted">
              {reset}
            </p>
          )}
        </div>
      </div>
    </Section>
  )
}
