'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import { ActiveSessionExistsError, createRepos, LearningSourceMissingError, type ArchiveResult } from '@sereno/db'
import { DEFAULT_SETTINGS, formatTimeBA, type Settings } from '@sereno/shared'
import { db, repos } from '../db'
import { requireSession } from '../session'
import { activeLive, failure, invalid, NOT_ACTIVE, SessionIdSchema, type Failure } from './results'

// Crear y archivar simulaciones (spec §11.1 primer uso, §11.1 Ajustes › Bot).

export interface ArchiveSummary {
  /** Abiertas que se cerraron al último precio de marca. */
  closed: number
  /** Abiertas sin precio actual que quedaron abiertas en la archivada. */
  leftOpen: number
  /** Hora del precio con que se cerraron. */
  markAt: number | null
}

/** Sin un precio actual (bot sin conexión) no se cierra nada: se puede reintentar con `closeOpen: false`. */
export type StaleMark = Failure<'stale_mark'> & { markAt: number | null }

export type CreateSessionResult =
  | { ok: true; sessionId: string; archived: ArchiveSummary | null }
  | StaleMark
  | Failure<'invalid' | 'learning_missing' | 'active_exists'>

export type ArchiveSessionResult = ({ ok: true } & ArchiveSummary) | StaleMark | Failure<'not_active' | 'invalid' | 'real_session'>

const REAL_SESSION = 'La sesión con plata real se apaga desde Ajustes › Plata real.'

const CreateInput = z.object({
  capital: z.number().positive().max(1e9),
  protectPct: z.number().min(0).max(1),
  mode: z.enum(['auto', 'custom']),
  learningOrigin: z.union([z.enum(['zero', 'continued']), z.templateLiteral(['replay:', z.string().min(1)])]),
  /** Cerrar las abiertas de la actual al último precio (por defecto); `false` las deja abiertas en la archivada. */
  closeOpen: z.boolean().optional(),
})

export type CreateSessionInput = z.input<typeof CreateInput>

/**
 * "Empezar a simular" y "Nueva simulación": archiva la simulación en papel activa (si hay)
 * y crea la nueva en una sola transacción; si algo falla, la actual sigue como estaba. La
 * sesión con plata real no se toca: vive aparte (Ajustes › Plata real).
 */
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const { user } = await requireSession()
  const parsed = CreateInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const { capital, protectPct, mode, learningOrigin, closeOpen = true } = parsed.data
  const settings: Settings = { ...DEFAULT_SETTINGS, mode, capital: { ...DEFAULT_SETTINGS.capital, protectPct } }

  try {
    const outcome = await db.transaction(async (tx) => {
      const r = createRepos(tx)
      const active = await r.sessions.getActive('paper_live')
      const archive = active ? await r.sessions.archive(active.id, { closeOpen }) : null
      // Archivar no tocó nada si el precio era viejo: se avisa antes de crear la nueva.
      if (archive && !archive.archived && archive.reason === 'stale_mark') return { stale: archive }
      const created = await r.sessions.createLive({ capitalInicial: capital, settings, learningOrigin, by: user.email })
      return { created, archive }
    })
    if ('stale' in outcome) return staleMark(outcome.stale.markAt)
    refresh()
    return { ok: true, sessionId: outcome.created.id, archived: outcome.archive?.archived ? summaryOf(outcome.archive) : null }
  } catch (err) {
    if (err instanceof LearningSourceMissingError) {
      return failure('learning_missing', 'No encontré ese aprendizaje para arrancar: elegí otro punto de partida.')
    }
    if (err instanceof ActiveSessionExistsError) {
      return failure('active_exists', 'Ya hay otra simulación activa: recargá y probá de nuevo.')
    }
    throw err
  }
}

const ArchiveInput = z.object({ sessionId: SessionIdSchema, closeOpen: z.boolean().optional() })

/**
 * Archiva la simulación en papel activa sin crear otra; por defecto cierra sus abiertas al
 * último precio. La de plata real no: cerrar en la base lo que sigue abierto en Binance la
 * descuadraría.
 */
export async function archiveSession(input: z.input<typeof ArchiveInput>): Promise<ArchiveSessionResult> {
  await requireSession()
  const parsed = ArchiveInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error)
  const { sessionId, closeOpen = true } = parsed.data
  const active = await activeLive(sessionId)
  if (!active) return failure('not_active', NOT_ACTIVE)
  if (active.kind === 'live') return failure('real_session', REAL_SESSION)
  const result = await repos.sessions.archive(sessionId, { closeOpen })
  if (!result.archived) return result.reason === 'stale_mark' ? staleMark(result.markAt) : failure('not_active', NOT_ACTIVE)
  refresh()
  return { ok: true, ...summaryOf(result) }
}

function summaryOf(result: Extract<ArchiveResult, { archived: true }>): ArchiveSummary {
  return { closed: result.closed.length, leftOpen: result.leftOpen.length, markAt: result.markAt?.getTime() ?? null }
}

function staleMark(markAt: Date | null): StaleMark {
  const when = markAt ? ` (el último es de las ${formatTimeBA(markAt.getTime())})` : ''
  return {
    ...failure('stale_mark', `No tengo un precio actual para cerrar las abiertas${when}. Podés esperar a que el bot vuelva o archivar sin cerrarlas.`),
    markAt: markAt?.getTime() ?? null,
  }
}
