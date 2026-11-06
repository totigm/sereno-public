'use client'

import { useEffect, useRef, useState } from 'react'
import type { SettingsPatch } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import { useToast } from '@/components/ui/toast'
import { setPause, updateSettings, type UpdateSettingsResult } from '@/lib/actions/settings'
import type { Unit } from './units'
import { validatePatch } from './validation'

// Edición de los ajustes de la simulación activa (spec §11.1 Ajustes y §11.4): cada
// cambio se valida en el cliente, se muestra al instante y sale a guardar con la
// versión que se vio; el toast trae "Deshacer" (escribe el valor anterior). Los
// guardados van en fila: cada uno sale con la versión que devolvió el anterior.

export interface Versioned {
  config: Settings
  version: number
}

export interface CommitOptions {
  /** Qué cambió, para el toast "Guardado: reinversión apagada.". */
  describe: string
  /** Una aclaración después del "Guardado" (el cambio de modo dice a qué posiciones aplica). */
  note?: string
  /** La unidad del campo, para los mensajes de validación. */
  unit?: Unit
  /** Una regla que el esquema no conoce (la liquidación del modo custom): su mensaje, o null. */
  check?: (next: Settings) => string | null
}

export interface SettingsEditor {
  config: Settings
  version: number
  /** Valida y, si pasa, guarda. Devuelve el error para mostrar junto al campo, o null. */
  commit: (patch: SettingsPatch, options: CommitOptions) => string | null
  /** Pausar o reanudar (la pausa es un ajuste, con quién y cuándo los pone el servidor). */
  setPaused: (paused: boolean, message: string) => void
}

export interface EditorInput {
  sessionId: string
  /** Lo que trajo la página (se vuelve a leer cuando una acción la refresca). */
  server: Versioned
  /** Lo último de `/api/live`: el bot también escribe ajustes (la pausa automática). */
  live: Versioned | null
  offline: boolean
}

const OFFLINE_NOTE = 'El bot lo toma cuando vuelva.'
const UNDONE = 'Volví al valor anterior.'
const FAILED = 'No pude guardar el cambio. Revisá la conexión y probá de nuevo.'

interface Write {
  patch: SettingsPatch
  call: (version: number) => Promise<UpdateSettingsResult>
  message: string
  undo?: () => void
}

/** Los grupos que toca `patch`, como estaban en `config`: lo que escribe "Deshacer". */
function groupsOf(config: Settings, patch: SettingsPatch): SettingsPatch {
  return Object.fromEntries(Object.keys(patch).map((key) => [key, config[key as keyof Settings]])) as SettingsPatch
}

function pauseGroup(paused: boolean): Settings['pause'] {
  return paused ? { paused: true, by: 'user', at: new Date().toISOString(), reason: null } : { paused: false, by: null, at: null, reason: null }
}

export function useSettingsEditor({ sessionId, server, live, offline }: EditorInput): SettingsEditor {
  const toast = useToast()
  const [shown, setShown] = useState<Versioned>(server)
  // Lo que se ve (con los cambios todavía en vuelo) y lo último que confirmó la base.
  const current = useRef(shown)
  const confirmed = useRef(server)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const inFlight = useRef(0)
  // Sube cuando un guardado falla: lo que estaba en la fila salió de un estado que ya no vale.
  const generation = useRef(0)
  const offlineRef = useRef(offline)
  offlineRef.current = offline

  const show = (next: Versioned) => {
    current.current = next
    setShown(next)
  }

  // Una versión más nueva que llega de afuera (la página refrescada, otra pestaña, el
  // bot) reemplaza lo que se ve, salvo mientras hay un guardado propio en camino.
  const adopt = (next: Versioned | null) => {
    if (!next || inFlight.current > 0 || next.version <= confirmed.current.version) return
    confirmed.current = next
    show(next)
  }
  // `adopt` sólo lee refs: alcanza con reevaluar cuando cambia lo que llega.
  useEffect(() => adopt(server), [server.version, server.config])
  useEffect(() => adopt(live), [live?.version, live?.config])

  const fail = (truth: Versioned, message: string) => {
    generation.current += 1
    confirmed.current = truth
    show(truth)
    toast({ message })
  }

  const send = async (write: Write) => {
    let result: UpdateSettingsResult
    try {
      result = await write.call(confirmed.current.version)
    } catch {
      return fail(confirmed.current, FAILED)
    }
    if (result.ok) {
      confirmed.current = { config: { ...confirmed.current.config, ...write.patch }, version: result.version }
      show({ config: current.current.config, version: result.version })
      toast(write.undo ? { message: write.message, undo: write.undo } : { message: write.message })
      return
    }
    // Conflicto: otro guardó en el medio. Se muestran los valores vigentes y su versión.
    if (result.reason === 'conflict' && result.settings && result.version !== null) {
      return fail({ config: result.settings, version: result.version }, result.message)
    }
    fail(confirmed.current, result.message)
  }

  const enqueue = (write: Write) => {
    const generationAtStart = generation.current
    inFlight.current += 1
    show({ config: { ...current.current.config, ...write.patch }, version: current.current.version })
    queue.current = queue.current.then(async () => {
      try {
        if (generationAtStart === generation.current) await send(write)
      } finally {
        inFlight.current -= 1
      }
    })
  }

  const undoTo = (previous: SettingsPatch) => () =>
    enqueue({ patch: previous, call: (version) => updateSettings(sessionId, previous, version), message: UNDONE })

  const savedMessage = (text: string) => (offlineRef.current ? `${text} ${OFFLINE_NOTE}` : text)

  const commit: SettingsEditor['commit'] = (patch, { describe, note, unit = 'count', check }) => {
    const config = current.current.config
    const error = validatePatch(config, patch, unit) ?? check?.({ ...config, ...patch }) ?? null
    if (error) return error
    enqueue({
      patch,
      call: (version) => updateSettings(sessionId, patch, version),
      message: savedMessage(note ? `Guardado: ${describe}. ${note}` : `Guardado: ${describe}.`),
      undo: undoTo(groupsOf(config, patch)),
    })
    return null
  }

  const setPaused: SettingsEditor['setPaused'] = (paused, message) => {
    const previous: SettingsPatch = { pause: current.current.config.pause }
    enqueue({
      patch: { pause: pauseGroup(paused) },
      call: (version) => setPause(sessionId, paused, version),
      message: savedMessage(message),
      undo: undoTo(previous),
    })
  }

  return { config: shown.config, version: shown.version, commit, setPaused }
}
