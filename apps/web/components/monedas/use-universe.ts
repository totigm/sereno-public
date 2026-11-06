'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { Settings } from '@sereno/shared'
import { useToast } from '@/components/ui/toast'
import { updateSettings, type UpdateSettingsResult } from '@/lib/actions/settings'
import { useLiveContext } from '@/lib/live/provider'

type Universe = Settings['universe']

interface Written {
  universe: Universe
  version: number
}

const FAILED = 'No pude guardar el cambio. Probá de nuevo.'

export interface UniverseActions {
  /** El universo vigente: el último que se escribió desde acá hasta que el vivo lo traiga. */
  universe: Universe | null
  /** La acción en curso (`"pin:SOLUSDT"`), para el spinner de su botón. */
  pending: string | null
  /** Escribe `next` y ofrece "Deshacer" durante 6 s con `message` (spec §11.1); termina cuando ya avisó. */
  apply: (key: string, next: Universe, message: string) => Promise<void>
}

/**
 * Fijar y excluir escriben el grupo `universe` de los ajustes con la versión vista
 * (optimistic locking, spec §10). Lo escrito se muestra enseguida, sin esperar al
 * próximo refresco en vivo; un conflicto avisa, adopta los ajustes vigentes que
 * devuelve la acción y vuelve a pedir la página.
 */
export function useUniverse(sessionId: string): UniverseActions {
  const { data } = useLiveContext()
  const toast = useToast()
  const router = useRouter()
  const [written, setWritten] = useState<Written | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const liveVersion = data.settingsVersion ?? 0
  const ahead = written !== null && written.version > liveVersion
  const universe = ahead ? written.universe : (data.settings?.universe ?? null)
  const version = ahead ? written.version : data.settingsVersion

  /** Escribe y devuelve la versión nueva, o null si no se pudo (ya avisado). */
  const write = async (next: Universe, expected: number): Promise<number | null> => {
    let result: UpdateSettingsResult
    try {
      result = await updateSettings(sessionId, { universe: next }, expected)
    } catch {
      toast({ message: FAILED })
      return null
    }
    if (result.ok) {
      setWritten({ universe: next, version: result.version })
      return result.version
    }
    toast({ message: result.message })
    if (result.reason === 'conflict' && result.settings !== null && result.version !== null) {
      setWritten({ universe: result.settings.universe, version: result.version })
    }
    if (result.reason !== 'invalid') router.refresh()
    return null
  }

  const apply = async (key: string, next: Universe, message: string) => {
    if (universe === null || version === null || pending !== null) return
    const previous = universe
    setPending(key)
    try {
      const after = await write(next, version)
      if (after !== null) toast({ message, undo: () => void write(previous, after) })
    } finally {
      setPending(null)
    }
  }

  return { universe, pending, apply }
}
