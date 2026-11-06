'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import { formatUsdRound } from '@sereno/core/src/journal/format'
import { ActiveSessionExistsError, createRepos, type ArchiveRealResult } from '@sereno/db'
import { parseCapital } from '../amount'
import { db, repos } from '../db'
import { capitalText, LOSS_FLOOR_TEXT } from '../real-copy'
import { canCreateReal, readinessMissing, readinessView, WALLET_UNREAD, type ReadinessView } from '../real-readiness'
import { databaseNow } from '../queries/sql/clock'
import { requireSession } from '../session'
import type { EnqueueResult } from './commands'
import { activeLive, failure, invalid, NOT_ACTIVE, SessionIdSchema, type Failure } from './results'

// Ajustes › Plata real (spec real §Cómo se prende, paso 4): crear la sesión, prenderla y
// apagarla. Nada de esto confía en el navegador: los chequeos se vuelven a leer de la
// base, el entorno sale de ellos (la web nunca lee `BINANCE_ENV`) y la confirmación se
// compara acá con el monto.

export type CreateRealResult = { ok: true; sessionId: string } | Failure<'invalid' | 'not_ready' | 'confirmation' | 'active_exists'>
export type TurnRealOnResult = { ok: true } | Failure<'invalid' | 'not_active' | 'not_ready' | 'confirmation' | 'loss_floor'>

const NOT_REAL = 'Esta sesión no opera con plata real: no cambié nada.'
const ACTIVE_EXISTS = 'Ya hay otra sesión con plata real activa: recargá y probá de nuevo.'

const CreateInput = z.object({
  capital: z.number().min(5).max(100_000),
  lossCap: z.number().min(0.1).max(1),
  confirmation: z.string().max(40),
})

const TurnOffInput = z.object({ id: z.uuid(), sessionId: SessionIdSchema })
const TurnOnInput = z.object({ sessionId: SessionIdSchema, confirmation: z.string().max(40) })

async function currentReadiness(): Promise<ReadinessView | null> {
  const [row, now] = await Promise.all([repos.realReadiness.latest(), databaseNow(db)])
  return row ? readinessView(row, now) : null
}

function notReady(missing: string[]): Failure<'not_ready'> {
  return failure('not_ready', `Todavía no se puede. Falta: ${missing.join('; ')}.`)
}

function confirmationFailure(capital: number): Failure<'confirmation'> {
  return failure('confirmation', `Escribí ${capitalText(capital)} para confirmar: es el capital que vas a usar.`)
}

const confirms = (text: string, capital: number): boolean => parseCapital(text) === capital

const PREVIOUS_NOT_ARCHIVED: Record<Exclude<ArchiveRealResult, { archived: true }>['reason'], string> = {
  still_on: ACTIVE_EXISTS,
  open_positions: 'La sesión con plata real anterior todavía tiene posiciones abiertas: esperá a que se cierren o cerralas desde ella.',
  not_active: ACTIVE_EXISTS,
}

/**
 * "Empezar con plata real": con los chequeos al día y en verde, el capital en la billetera
 * y el monto escrito. Una real anterior apagada (a mano o por el tope) y sin abiertas se
 * archiva en la misma transacción; si no se puede, no se crea nada.
 */
export async function createRealSession(input: z.input<typeof CreateInput>): Promise<CreateRealResult> {
  const { user } = await requireSession()
  const parsed = CreateInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const { capital, lossCap, confirmation } = parsed.data
  if (!confirms(confirmation, capital)) return confirmationFailure(capital)

  const [readiness, previous] = await Promise.all([currentReadiness(), repos.sessions.getActive('live')])
  const ready = canCreateReal(readiness, previous?.realStatus ? { status: previous.realStatus } : null)
  if (!ready.ok) return notReady(ready.missing)
  // `canCreateReal` ya exige los chequeos y la billetera leída: esto es para el tipo.
  if (readiness === null || readiness.walletAvailable === null) return notReady([WALLET_UNREAD])
  const wallet = readiness.walletAvailable
  if (wallet < capital) {
    return failure('not_ready', `En la billetera de futuros hay ${formatUsdRound(wallet)} disponibles: no alcanza para ${formatUsdRound(capital)}.`)
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      const r = createRepos(tx)
      const active = await r.sessions.getActive('live')
      if (active) {
        const archived = await r.sessions.archiveReal(active.id)
        if (!archived.archived) return { blocked: PREVIOUS_NOT_ARCHIVED[archived.reason] }
      }
      return { created: await r.sessions.createReal({ capitalInicial: capital, lossCap, binanceEnv: readiness.env, by: user.email }) }
    })
    if ('blocked' in outcome) return failure('active_exists', outcome.blocked)
    refresh()
    return { ok: true, sessionId: outcome.created.id }
  } catch (err) {
    if (err instanceof ActiveSessionExistsError) return failure('active_exists', ACTIVE_EXISTS)
    throw err
  }
}

/**
 * "Cerrar todo y apagar": la sesión queda apagada en la base ya mismo (el bot deja de abrir
 * en su próxima lectura) y se le pide cerrar todo con `real_off`, que no vence. El `id`
 * es la clave de idempotencia del comando, como en el resto de los comandos.
 */
export async function turnRealOff(input: z.input<typeof TurnOffInput>): Promise<EnqueueResult> {
  const { user } = await requireSession()
  const parsed = TurnOffInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const { id, sessionId } = parsed.data
  const session = await activeLive(sessionId)
  if (!session) return failure('not_active', NOT_ACTIVE)
  if (session.kind !== 'live') return failure('not_active', NOT_REAL)
  const inserted = await db.transaction(async (tx) => {
    const r = createRepos(tx)
    // `false` es que ya no es la real activa, o que llegó al tope: ésa ya está apagada (y
    // así queda), y el comando igual cierra lo que quede.
    if (!(await r.sessions.setRealStatus(sessionId, 'off', 'user'))) {
      const row = await r.sessions.get(sessionId)
      if (row?.status !== 'active' || row.realStatus !== 'loss_floor') return null
    }
    return r.commands.enqueue({ id, sessionId, kind: 'real_off', payload: {}, requestedBy: user.email })
  })
  if (inserted === null) return failure('not_active', NOT_ACTIVE)
  refresh()
  return { ok: true, id, duplicate: !inserted }
}

/** "Prender" una sesión real apagada a mano: los mismos chequeos que para crearla y el monto escrito. */
export async function turnRealOn(input: z.input<typeof TurnOnInput>): Promise<TurnRealOnResult> {
  await requireSession()
  const parsed = TurnOnInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const { sessionId, confirmation } = parsed.data
  const session = await activeLive(sessionId)
  if (!session) return failure('not_active', NOT_ACTIVE)
  if (session.kind !== 'live') return failure('not_active', NOT_REAL)
  if (session.realStatus === 'loss_floor') return failure('loss_floor', LOSS_FLOOR_TEXT)
  if (session.realStatus !== 'off') return { ok: true }
  if (!confirms(confirmation, session.capitalInicial)) return confirmationFailure(session.capitalInicial)
  const missing = readinessMissing(await currentReadiness(), { newSession: false })
  if (missing.length > 0) return notReady(missing)
  // `setRealStatus` no prende una que llegó al tope entre la lectura y la escritura.
  if (!(await repos.sessions.setRealStatus(sessionId, 'on', null))) return failure('loss_floor', LOSS_FLOOR_TEXT)
  refresh()
  return { ok: true }
}
