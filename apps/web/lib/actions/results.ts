import { z } from 'zod'
import type { SessionRow } from '@sereno/db'
import { repos } from '../db'

// Lo que devuelven las Server Actions: nunca tiran por un error esperable; dicen qué
// pasó con un `reason` para la lógica y un `message` listo para el toast o la banda.

export type Failure<R extends string> = { ok: false; reason: R; message: string }

export const NOT_ACTIVE = 'Esta simulación ya no está activa: no cambié nada.'

export function failure<R extends string>(reason: R, message: string): Failure<R> {
  return { ok: false, reason, message }
}

export function invalid(error: z.ZodError): Failure<'invalid'> {
  const issue = error.issues[0]
  const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''
  return failure('invalid', `El pedido no es válido${where}: ${issue?.message ?? 'revisá los datos'}.`)
}

/** La sesión si es una activa (la simulación en papel o la de plata real): las únicas sobre las que se actúa (spec §11.1). */
export async function activeLive(sessionId: string): Promise<SessionRow | null> {
  const row = await repos.sessions.get(sessionId)
  return row && row.status === 'active' && row.kind !== 'replay' ? row : null
}

export const SessionIdSchema = z.string().min(1).max(200)
