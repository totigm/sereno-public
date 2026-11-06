'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import type { CancelOutcome } from '@sereno/db'
import { CommandSchema, type CommandInput } from '@sereno/shared'
import { repos } from '../db'
import { requireSession } from '../session'
import { activeLive, failure, invalid, NOT_ACTIVE, SessionIdSchema, type Failure } from './results'

// Comandos al bot (spec §10): el id lo genera el cliente (`crypto.randomUUID()`) antes
// de mandar, así reintentar un envío nunca duplica un cierre. `requestedBy` es el email
// de la sesión, no algo que mande el navegador.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Un comando tal como lo arma la pantalla: todo menos `requestedBy`. */
export type EnqueueCommandInput = DistributiveOmit<CommandInput, 'requestedBy'>

export type EnqueueResult =
  /** `duplicate`: ese id ya estaba en la cola (un reintento); no se encoló otra vez. */
  | { ok: true; id: string; duplicate: boolean }
  | Failure<'not_active' | 'invalid'>

export type CancelResult = { ok: true } | Failure<'not_active' | 'other_session' | 'not_pending' | 'not_found' | 'invalid'>

export async function enqueueCommand(input: EnqueueCommandInput): Promise<EnqueueResult> {
  const { user } = await requireSession()
  const command = CommandSchema.safeParse({ ...input, requestedBy: user.email })
  if (!command.success) return invalid(command.error)
  if (!(await activeLive(command.data.sessionId))) return failure('not_active', NOT_ACTIVE)
  const inserted = await repos.commands.enqueue(command.data)
  refresh()
  return { ok: true, id: command.data.id, duplicate: !inserted }
}

/**
 * "Cancelar" mientras el bot no lo tomó: saca de la cola un comando de una sesión activa,
 * la simulación en papel o la de plata real (cada una tiene sus "Cerrar ahora").
 */
export async function cancelCommand(id: string): Promise<CancelResult> {
  await requireSession()
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) return invalid(parsed.error)
  const actives = (await Promise.all([repos.sessions.getActive('paper_live'), repos.sessions.getActive('live')])).filter((s) => s !== null)
  if (actives.length === 0) return failure('not_active', NOT_ACTIVE)
  switch (await cancelInAny(parsed.data, actives.map((s) => s.id))) {
    case 'cancelled':
      refresh()
      return { ok: true }
    case 'not_pending':
      return failure('not_pending', 'El bot ya lo tomó: no se puede cancelar.')
    case 'other_session':
      return failure('other_session', 'Ese comando es de otra simulación, no de la activa: no lo cancelé.')
    case 'not_found':
      return failure('not_found', 'No encontré ese comando: no cancelé nada.')
  }
}

// `other_session` sólo si no es de ninguna de las activas; cualquier otra respuesta es definitiva.
async function cancelInAny(id: string, sessionIds: string[]): Promise<CancelOutcome> {
  let outcome: CancelOutcome = 'not_found'
  for (const sessionId of sessionIds) {
    outcome = await repos.commands.cancel(id, sessionId)
    if (outcome !== 'other_session') return outcome
  }
  return outcome
}

const Target = z.object({ id: z.uuid(), sessionId: SessionIdSchema })

/** "Volver a usar el capital blindado" (spec §7): lo aplica el bot, que lleva la cuenta. */
export async function releaseProtected(target: z.input<typeof Target>): Promise<EnqueueResult> {
  return enqueueCommand({ ...target, kind: 'release_protected', payload: {} })
}

/** "Reiniciar aprendizaje" (spec §8): la simulación vuelve a los valores por defecto. */
export async function resetLearning(target: z.input<typeof Target>): Promise<EnqueueResult> {
  return enqueueCommand({ ...target, kind: 'reset_learning', payload: {} })
}

export type RunReplayInput = z.input<typeof Target> & Extract<CommandInput, { kind: 'run_replay' }>['payload']

/** "Correr un replay" (spec §9): sale de la simulación activa y lo corre el bot; sin bot, queda en cola. */
export async function runReplay({ id, sessionId, ...payload }: RunReplayInput): Promise<EnqueueResult> {
  return enqueueCommand({ id, sessionId, kind: 'run_replay', payload })
}
