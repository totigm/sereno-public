'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import type { SettingsPatch } from '@sereno/db'
import { SettingsSchema, type Settings } from '@sereno/shared'
import { repos } from '../db'
import { requireSession } from '../session'
import { activeLive, failure, invalid, NOT_ACTIVE, SessionIdSchema, type Failure } from './results'

// Ajustes de la simulación activa (spec §10, §11.1 Ajustes): optimistic locking con la
// versión que vio quien edita. Un parche reemplaza grupos enteros (`risk`, `pause`…):
// "Deshacer" es volver a mandar el grupo anterior con la versión nueva.

export type UpdateSettingsResult =
  | { ok: true; version: number }
  /**
   * Otro guardó en el medio: `version` y `settings` son los vigentes, leídos juntos (null si
   * la sesión no tiene ajustes). La página también se refresca.
   */
  | (Failure<'conflict'> & { version: number | null; settings: Settings | null })
  | Failure<'not_active' | 'invalid'>

const CONFLICT = 'Los ajustes cambiaron mientras los editabas: te muestro la versión nueva.'

const UpdateInput = z.object({
  sessionId: SessionIdSchema,
  patch: SettingsSchema.partial(),
  expectedVersion: z.number().int().min(1),
})

export async function updateSettings(sessionId: string, patch: SettingsPatch, expectedVersion: number): Promise<UpdateSettingsResult> {
  const { user } = await requireSession()
  const input = UpdateInput.safeParse({ sessionId, patch, expectedVersion })
  if (!input.success) return invalid(input.error)
  return write(user.email, input.data.sessionId, definedGroups(input.data.patch), input.data.expectedVersion)
}

/** Pausar o reanudar (spec §7): la pausa es un ajuste, con quién y cuándo los pone el servidor. */
export async function setPause(sessionId: string, paused: boolean, expectedVersion: number): Promise<UpdateSettingsResult> {
  const { user } = await requireSession()
  const pause: Settings['pause'] = paused
    ? { paused: true, by: 'user', at: new Date().toISOString(), reason: null }
    : { paused: false, by: null, at: null, reason: null }
  const input = UpdateInput.safeParse({ sessionId, patch: { pause }, expectedVersion })
  if (!input.success) return invalid(input.error)
  return write(user.email, input.data.sessionId, definedGroups(input.data.patch), input.data.expectedVersion)
}

// El `partial()` de zod tipa cada grupo como `T | undefined`; el parche del repositorio
// sólo lleva los grupos presentes.
function definedGroups(patch: z.output<typeof UpdateInput>['patch']): SettingsPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, group]) => group !== undefined)) as SettingsPatch
}

async function write(email: string, sessionId: string, patch: SettingsPatch, expectedVersion: number): Promise<UpdateSettingsResult> {
  if (!(await activeLive(sessionId))) return failure('not_active', NOT_ACTIVE)
  let result
  try {
    result = await repos.settings.update(sessionId, patch, expectedVersion, { by: email })
  } catch (err) {
    // El parche es válido por grupo, pero junto con el resto puede no serlo.
    if (err instanceof z.ZodError) return invalid(err)
    throw err
  }
  if (!result.ok || result.version === null) {
    const current = await repos.settings.get(sessionId)
    refresh()
    return { ...failure('conflict', CONFLICT), version: current?.version ?? null, settings: current?.config ?? null }
  }
  refresh()
  return { ok: true, version: result.version }
}
