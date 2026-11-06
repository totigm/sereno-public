import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, getTableColumns, inArray, ne, notInArray, sql } from 'drizzle-orm'
import {
  COMMAND_TTL_MS,
  DEFAULT_SETTINGS,
  SettingsSchema,
  type BinanceEnv,
  type LearningOrigin,
  type RealOffReason,
  type RealStatus,
  type ReplayStatus,
  type Settings,
} from '@sereno/shared'
import type { Db } from '../client'
import { learningState, sessions, type ReplayParams, type ReplayReport } from '../schema'
import { applyArchiveCloses, listOpenIds, planArchiveCloses, type ArchiveClose } from './archive-close'
import { ActiveSessionExistsError, isUniqueViolation, LearningSourceMissingError } from './errors'
import { createLearningRepo } from './learning'
import { createSettingsRepo } from './settings'
import { dbNow, transactionNow } from './sql-helpers'

// Una sesión sin su reporte de replay: el selector de sesiones, la cola de replays y el
// runtime no cargan decenas de KB por fila. El reporte se lee con `getReport`.
export type SessionRow = Omit<typeof sessions.$inferSelect, 'report'>

const { report: _report, ...SESSION_COLUMNS } = getTableColumns(sessions)

export interface CreateLiveInput {
  capitalInicial: number
  settings: Settings
  learningOrigin: LearningOrigin
  name?: string
  // Email de quien la creó: queda como autor de la versión 1 de los ajustes.
  by?: string | null
}

export interface CreateRealInput {
  // El capital asignado: la sesión opera como si la cuenta tuviera sólo eso.
  capitalInicial: number
  // Fracción del capital que puede perder antes de cerrar todo y apagarse (0,1..1).
  lossCap: number
  binanceEnv: BinanceEnv
  by?: string | null
}

export interface CreateReplayInput {
  name: string
  capitalInicial: number
  settings: Settings
  learningOrigin: LearningOrigin
  replayParams: ReplayParams
}

export interface ProgressUpdate {
  status: ReplayStatus
  progreso: number
  mensaje: string
}

export interface ReplayCompletion {
  report: ReplayReport
  mensaje: string
}

export interface ArchiveOptions {
  closeOpen: boolean
  // Antigüedad máxima del precio de marca para cerrar con él; por defecto, la
  // misma que un comando sensible al precio (60 s).
  maxMarkAgeMs?: number
}

// `markAt` es el instante del precio de marca con que se cerró (o con que no se
// quiso cerrar, por viejo); null si no se valuó nada. Con `stale_mark` no cambió
// nada: el dashboard avisa y puede archivar con `closeOpen: false`.
export type ArchiveResult =
  | { archived: true; closed: ArchiveClose[]; leftOpen: string[]; markAt: Date | null }
  | { archived: false; reason: 'not_active' | 'stale_mark' | 'real_session'; markAt: Date | null }

// La sesión real se archiva sólo apagada y sin abiertas: nunca se cierra nada en la base
// que siga abierto en Binance.
export type ArchiveRealResult = { archived: true } | { archived: false; reason: 'still_on' | 'open_positions' | 'not_active' }

type ActiveKind = 'paper_live' | 'live'

const ACTIVE_PER_KIND_INDEX = 'sessions_single_active_per_kind_idx'
const FINISHED_REPLAY: ReplayStatus[] = ['listo', 'fallido', 'cancelado']

function assertCapital(capitalInicial: number): void {
  if (!(Number.isFinite(capitalInicial) && capitalInicial > 0)) {
    throw new RangeError(`El capital inicial tiene que ser positivo (recibido ${capitalInicial})`)
  }
}

function newSessionId(): string {
  return `ses_${randomUUID()}`
}

// Copia el aprendizaje de origen a la sesión nueva: `continued` sigue con la
// simulación en papel más reciente que aprendió algo (nunca con la de plata real,
// que aprende con poca plata y otro capital); `replay:<id>`, con ese replay.
async function copyLearning(tx: Db, origin: Exclude<LearningOrigin, 'zero'>, toId: string): Promise<void> {
  let sourceId: string | undefined
  if (origin.startsWith('replay:')) {
    sourceId = origin.slice('replay:'.length)
  } else {
    const [last] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(learningState, eq(learningState.sessionId, sessions.id))
      .where(eq(sessions.kind, 'paper_live'))
      .orderBy(desc(sessions.startedAt))
      .limit(1)
    sourceId = last?.id
  }
  const learning = createLearningRepo(tx)
  const state = sourceId === undefined ? null : await learning.get(sourceId)
  if (!state) throw new LearningSourceMissingError(origin)
  await learning.save(toId, state)
}

// La sesión con plata real nace prendida y atada a su entorno de Binance.
type NewActiveSession = {
  name: string
  capitalInicial: number
  settings: Settings
  learningOrigin: LearningOrigin
  by: string | null
} & ({ kind: 'paper_live' } | { kind: 'live'; binanceEnv: BinanceEnv })

// Una sesión activa nueva con sus ajustes (versión 1) y, si se pidió, el aprendizaje
// de otra sesión. Todo o nada; lanza si ya hay una activa del mismo tipo.
async function insertActive(db: Db, input: NewActiveSession): Promise<SessionRow> {
  const { kind, capitalInicial, learningOrigin, by } = input
  assertCapital(capitalInicial)
  const config = SettingsSchema.parse(input.settings)
  const id = newSessionId()
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sessions)
        .values({
          id,
          kind,
          name: input.name,
          status: 'active',
          capitalInicial,
          baseBlindaje: capitalInicial,
          protegido: 0,
          settingsSnapshot: config,
          learningOrigin,
          startedAt: dbNow,
          ...(input.kind === 'live' && { binanceEnv: input.binanceEnv, realStatus: 'on' as const, realChangedAt: dbNow }),
        })
        .returning(SESSION_COLUMNS)
      if (!row) throw new Error(`No se pudo crear la sesión ${input.name}`)
      await createSettingsRepo(tx).create(id, config, { by })
      if (learningOrigin !== 'zero') await copyLearning(tx, learningOrigin, id)
      return row
    })
  } catch (err) {
    if (isUniqueViolation(err, ACTIVE_PER_KIND_INDEX)) throw new ActiveSessionExistsError(kind)
    throw err
  }
}

export function createSessionsRepo(db: Db) {
  return {
    async createLive({ capitalInicial, settings, learningOrigin, name = 'Simulación', by = null }: CreateLiveInput): Promise<SessionRow> {
      return insertActive(db, { kind: 'paper_live', name, capitalInicial, settings, learningOrigin, by })
    },

    // La sesión con plata real: prendida, con los ajustes por defecto más su tope de
    // pérdida y el aprendizaje de cero. Lanza si ya hay una real activa.
    async createReal({ capitalInicial, lossCap, binanceEnv, by = null }: CreateRealInput): Promise<SessionRow> {
      return insertActive(db, {
        kind: 'live',
        name: 'Plata real',
        capitalInicial,
        settings: { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap } },
        learningOrigin: 'zero',
        by,
        binanceEnv,
      })
    },

    // Un replay pedido desde el dashboard o la línea de comandos: queda en cola
    // hasta que el bot lo tome.
    async createReplay(input: CreateReplayInput): Promise<SessionRow> {
      assertCapital(input.capitalInicial)
      const [row] = await db
        .insert(sessions)
        .values({
          id: newSessionId(),
          kind: 'replay',
          name: input.name,
          status: 'en_cola',
          capitalInicial: input.capitalInicial,
          baseBlindaje: input.capitalInicial,
          protegido: 0,
          settingsSnapshot: SettingsSchema.parse(input.settings),
          learningOrigin: input.learningOrigin,
          startedAt: dbNow,
          progreso: 0,
          replayParams: input.replayParams,
        })
        .returning(SESSION_COLUMNS)
      if (!row) throw new Error('No se pudo crear el replay')
      return row
    },

    // La activa de ese tipo: la simulación en papel o la de plata real.
    async getActive(kind: ActiveKind): Promise<SessionRow | null> {
      const [row] = await db
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(and(eq(sessions.status, 'active'), eq(sessions.kind, kind)))
      return row ?? null
    },

    async get(id: string): Promise<SessionRow | null> {
      const [row] = await db.select(SESSION_COLUMNS).from(sessions).where(eq(sessions.id, id))
      return row ?? null
    },

    // El reporte de un replay terminado; null mientras corre o si no terminó bien.
    async getReport(id: string): Promise<ReplayReport | null> {
      const [row] = await db.select({ report: sessions.report }).from(sessions).where(eq(sessions.id, id))
      return row?.report ?? null
    },

    // Los replays en esos estados en el orden en que se pidieron: el de la cola.
    async listReplays(statuses: readonly ReplayStatus[]): Promise<SessionRow[]> {
      if (statuses.length === 0) return []
      return db
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(and(eq(sessions.kind, 'replay'), inArray(sessions.status, [...statuses])))
        .orderBy(asc(sessions.startedAt), asc(sessions.id))
    },

    // Las más recientes primero.
    async listAll(): Promise<SessionRow[]> {
      return db.select(SESSION_COLUMNS).from(sessions).orderBy(desc(sessions.startedAt), desc(sessions.id))
    },

    // Archiva la simulación en papel activa. Con `closeOpen`, sus abiertas (reales y
    // sombra) se cierran en la misma transacción al último precio de marca, si
    // ese precio es actual; si no, no archiva. `leftOpen` lista las que quedan
    // abiertas en la sesión archivada (todas, sin `closeOpen`).
    async archive(id: string, { closeOpen, maxMarkAgeMs = COMMAND_TTL_MS }: ArchiveOptions): Promise<ArchiveResult> {
      return db.transaction(async (tx) => {
        // El bloqueo hace que un segundo archivo en paralelo espere y después no la
        // encuentre activa, y que el bot no escriba posiciones hasta que termine.
        const [locked] = await tx
          .select({ session: SESSION_COLUMNS, now: transactionNow() })
          .from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.status, 'active')))
          .for('update')
        if (!locked) return { archived: false, reason: 'not_active', markAt: null }
        // Cerrar en la base lo que sigue abierto en Binance la descuadraría: la real va por `archiveReal`.
        if (locked.session.kind === 'live') return { archived: false, reason: 'real_session', markAt: null }
        const plan = closeOpen ? await planArchiveCloses(tx, locked.session, maxMarkAgeMs) : null
        if (plan && !plan.fresh) return { archived: false, reason: 'stale_mark', markAt: plan.markAt }

        // Los cierres van antes de marcarla archivada: después, el repo de posiciones
        // ya no le escribe. Comparten con el archivo el mismo instante.
        const endedAt = locked.now
        const outcome = plan
          ? await applyArchiveCloses(tx, id, plan, endedAt.getTime())
          : { closed: [], leftOpen: await listOpenIds(tx, id) }
        await tx.update(sessions).set({ status: 'archived', endedAt }).where(eq(sessions.id, id))
        return { archived: true, markAt: plan?.markAt ?? null, ...outcome }
      })
    },

    // Archiva la sesión real activa, sólo si ya no opera (apagada o en el tope) y no le
    // queda nada abierto. El bloqueo frena al bot mientras tanto, como en `archive`.
    async archiveReal(id: string): Promise<ArchiveRealResult> {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ realStatus: sessions.realStatus, now: transactionNow() })
          .from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.kind, 'live'), eq(sessions.status, 'active')))
          .for('update')
        if (!locked) return { archived: false, reason: 'not_active' }
        if (locked.realStatus === 'on') return { archived: false, reason: 'still_on' }
        if ((await listOpenIds(tx, id)).length > 0) return { archived: false, reason: 'open_positions' }
        await tx.update(sessions).set({ status: 'archived', endedAt: locked.now }).where(eq(sessions.id, id))
        return { archived: true }
      })
    },

    // Prende o apaga la sesión real activa. `loss_floor` es terminal: después del tope
    // sólo se opera con una sesión nueva. `realChangedAt` es cuándo cambió de estado:
    // apagar una ya apagada no lo mueve (y devuelve true). Devuelve false sólo si la
    // sesión no es la `live` activa o si ya está en `loss_floor`.
    async setRealStatus(id: string, next: RealStatus, reason: RealOffReason | null): Promise<boolean> {
      const updated = await db
        .update(sessions)
        .set({
          realStatus: next,
          realOffReason: reason,
          realChangedAt: sql`case when ${sessions.realStatus} = ${next} then ${sessions.realChangedAt} else now() end`,
        })
        .where(and(eq(sessions.id, id), eq(sessions.kind, 'live'), eq(sessions.status, 'active'), ne(sessions.realStatus, 'loss_floor')))
        .returning({ id: sessions.id })
      return updated.length > 0
    },

    // Avance de un replay. Un replay terminado (listo, fallido, cancelado) no
    // cambia más: si devuelve false, quien lo corre sabe que lo cancelaron.
    async updateProgress(id: string, { status, progreso, mensaje }: ProgressUpdate): Promise<boolean> {
      const done = FINISHED_REPLAY.includes(status)
      const updated = await db
        .update(sessions)
        .set({ status, progreso, mensaje, ...(done ? { endedAt: dbNow } : {}) })
        .where(and(eq(sessions.id, id), eq(sessions.kind, 'replay'), notInArray(sessions.status, FINISHED_REPLAY)))
        .returning({ id: sessions.id })
      return updated.length > 0
    },

    // Un replay que terminó bien: `listo` con progreso 1 y su reporte, en una sola
    // escritura. Si ya había terminado (lo cancelaron), no cambia y devuelve false.
    async completeReplay(id: string, { report, mensaje }: ReplayCompletion): Promise<boolean> {
      const updated = await db
        .update(sessions)
        .set({ status: 'listo', progreso: 1, mensaje, report, endedAt: dbNow })
        .where(and(eq(sessions.id, id), eq(sessions.kind, 'replay'), notInArray(sessions.status, FINISHED_REPLAY)))
        .returning({ id: sessions.id })
      return updated.length > 0
    },

    // Con qué aprendizaje arrancó de verdad un replay: pedido con el vigente, arranca de
    // cero si no había nada aprendido para continuar.
    async setReplayLearningOrigin(id: string, learningOrigin: LearningOrigin): Promise<boolean> {
      const updated = await db
        .update(sessions)
        .set({ learningOrigin })
        .where(and(eq(sessions.id, id), eq(sessions.kind, 'replay')))
        .returning({ id: sessions.id })
      return updated.length > 0
    },

    // Estado del blindaje (spec §7): lo persiste el bot cuando se dispara y
    // cuando Toti vuelve a usar el capital blindado.
    async updateShield(id: string, shield: { protegido: number; baseBlindaje: number }): Promise<boolean> {
      const updated = await db.update(sessions).set(shield).where(eq(sessions.id, id)).returning({ id: sessions.id })
      return updated.length > 0
    },
  }
}

export type SessionsRepo = ReturnType<typeof createSessionsRepo>
