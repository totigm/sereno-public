// Una sesión del proceso por tipo (spec §12): la simulación en papel (`paper_live`) o la
// real (`live`). Cada 10 s: si opera una, renueva su lease y escribe el latido; si la
// archivaron o perdió el lease, deja de operarla; si no opera ninguna, busca la activa y
// toma su lease (o espera en `waiting_lease`). Errores recientes, reintento al minuto y
// latido son de cada slot: uno que falla nunca frena al otro.

import type { BotFlags, Repos, SessionRow } from '@sereno/db'
import type { BotPhase } from '@sereno/shared'
import { errorMessage } from '../jobs/errors'
import type { Logger } from '../logger'
import { heartbeatInput, NO_FLAGS, RecentErrors, type StatusView } from './heartbeat'
import type { Lease } from './lease'
import { SessionClosedError } from './session'
import type { Clock } from './timers'

// Comandos que un proceso anterior reclamó y no terminó (spec §10): quedan fallidos.
export const STALE_CLAIM_MS = 60_000
// Espera antes de reintentar una sesión que no pudo arrancar (Binance caído, por ejemplo).
export const RETRY_OPEN_MS = 60_000

// Lo que el slot opera: la sesión en vivo o, en la real sin con qué hablar con Binance, una
// que sólo informa por qué no opera.
export interface SlotSession {
  readonly id: string
  readonly phase: BotPhase
  start(): Promise<void>
  stop(opts: { flush: boolean }): Promise<void>
  status(): StatusView
}

export interface OpenContext {
  // Los cortes del último latido guardado (null si la sesión nunca tuvo uno).
  lastFlags: BotFlags | null
  errors: RecentErrors
  // La sesión terminó sola (la archivaron): el slot la retira y busca la nueva.
  onEnded: () => void
}

export interface SessionSlotDeps<S extends SlotSession> {
  kind: 'paper_live' | 'live'
  repos: Repos
  lease: Lease
  clock: Clock
  logger: Logger
  // Lo que se loguea una vez mientras no hay sesión activa de este tipo.
  idleMessage: string
  open: (row: SessionRow, ctx: OpenContext) => S
  // Ya arrancó (una vez por arranque exitoso).
  onStarted?: (session: S) => void
}

const WAITING: StatusView = {
  phase: 'waiting_lease',
  warmProgress: 0,
  universeSize: 0,
  lastCycleAt: null,
  settingsVersionApplied: null,
  degradedSymbols: [],
  flags: NO_FLAGS,
}

export class SessionSlot<S extends SlotSession> {
  readonly errors = new RecentErrors()
  private session: S | null = null
  private opening: Promise<void> | null = null
  private waitingFor: string | null = null
  private idle = false
  private retryAt = 0
  private ticks: Promise<void> = Promise.resolve()
  private stopping = false
  private errorsSession: string | null = null

  constructor(private readonly deps: SessionSlotDeps<S>) {}

  // La que opera ahora (también mientras arranca).
  current(): S | null {
    return this.session
  }

  status(): { phase: BotPhase | null; sessionId: string | null } {
    if (this.session) return { phase: this.session.phase, sessionId: this.session.id }
    if (this.waitingFor) return { phase: 'waiting_lease', sessionId: this.waitingFor }
    return { phase: null, sessionId: null }
  }

  async ready(): Promise<void> {
    await this.opening
  }

  // De a uno: el del programador y el que dispara el fin de una sesión no se pisan.
  tick(): Promise<void> {
    const run = this.ticks.then(() => this.tickOnce())
    this.ticks = run.catch((error: unknown) => this.recordError('Falló el latido', error))
    return this.ticks
  }

  // Apagado ordenado: guarda lo pendiente, último latido y suelta el lease.
  async stop(): Promise<void> {
    this.stopping = true
    await this.ticks
    const session = this.session
    this.session = null
    if (!session) return
    await session.stop({ flush: true })
    await this.beat(session.id, session.status())
    await this.deps.lease.release(session.id).catch((error: unknown) => this.recordError('No pude soltar el lease', error))
  }

  // Para lo que pasa fuera de la sesión pero la afecta (el stream de mercado del proceso).
  pushError(message: string): void {
    this.errors.push(this.deps.clock.now(), message)
  }

  private async tickOnce(): Promise<void> {
    if (this.stopping) return
    const session = this.session
    if (session && (await this.keep(session))) return
    if (this.opening || this.deps.clock.now() < this.retryAt) return
    await this.discover()
  }

  // Sigue operando si la sesión sigue activa y el lease sigue siendo suyo.
  private async keep(session: S): Promise<boolean> {
    const { repos, lease, logger } = this.deps
    const row = await repos.sessions.get(session.id)
    if (!row || row.status !== 'active') {
      await this.retire(session, true)
      return false
    }
    if (!(await lease.take(session.id))) {
      logger.error({ sessionId: session.id }, 'Otra instancia tomó el lease: dejo de operar')
      await this.retire(session, false)
      return false
    }
    await this.beat(session.id, session.status())
    return true
  }

  private async discover(): Promise<void> {
    const { repos, lease, logger } = this.deps
    const active = await repos.sessions.getActive(this.deps.kind)
    if (!active) {
      if (!this.idle) logger.info(this.deps.idleMessage)
      this.idle = true
      return
    }
    this.idle = false
    if (!(await lease.take(active.id))) {
      if (this.waitingFor !== active.id) logger.warn({ sessionId: active.id }, 'Otra instancia opera la sesión: espero el lease')
      this.waitingFor = active.id
      // Este latido sólo se escribe si el dueño ya no tiene lease vigente: conserva sus
      // cortes, que son de los que se retoma la sesión al tomarla.
      const previous = await repos.bot.get(active.id)
      await this.beat(active.id, { ...WAITING, flags: previous?.flags ?? NO_FLAGS })
      return
    }
    this.waitingFor = null
    this.opening = this.open(active).then((retired) => {
      this.opening = null
      // La retiraron mientras arrancaba: la activa nueva se busca enseguida, sin esperar al
      // próximo latido ni al minuto de reintento.
      if (retired) void this.tick()
    })
  }

  // true si la sesión se retiró mientras arrancaba (la archivaron o se apaga el proceso).
  private async open(row: SessionRow): Promise<boolean> {
    const { repos, lease, logger } = this.deps
    let session: S | null = null
    try {
      const failed = await repos.commands.failStaleClaims(row.id, STALE_CLAIM_MS)
      if (failed > 0) logger.warn({ failed }, 'Comandos de un proceso anterior quedaron fallidos')
      // Antes del primer latido: el de "arrancando" todavía no tiene motor y pisaría los
      // cortes que dejó el proceso anterior (la pausa por drawdown se retoma de ahí).
      const previous = await repos.bot.get(row.id)
      this.errorsFor(row.id)
      const created = this.deps.open(row, {
        lastFlags: previous?.flags ?? null,
        errors: this.errors,
        onEnded: () => {
          void this.retire(created, true).then(() => this.tick())
        },
      })
      session = created
      this.session = created
      await this.beat(row.id, created.status())
      await created.start()
      await this.beat(row.id, created.status())
      this.deps.onStarted?.(created)
      return false
    } catch (error) {
      if (error instanceof SessionClosedError) return true
      this.recordError('No pude arrancar la sesión; reintento en un minuto', error)
      this.retryAt = this.deps.clock.now() + RETRY_OPEN_MS
      if (session === null) await lease.release(row.id).catch((e: unknown) => this.recordError('No pude soltar el lease', e))
      else if (this.session === session) await this.retire(session, true)
      return false
    }
  }

  // Los errores recientes son de la sesión que se opera: al pasar a otra (archivo, "Nueva
  // simulación") los de la anterior no se le muestran a la nueva.
  private errorsFor(sessionId: string): void {
    if (this.errorsSession !== sessionId) this.errors.clear()
    this.errorsSession = sessionId
  }

  // Deja de operar la sesión. Con `release` guarda lo pendiente y suelta el lease; sin él
  // (otra instancia lo tomó) no escribe nada más.
  private async retire(session: S, release: boolean): Promise<void> {
    if (this.session !== session) return
    this.session = null
    await session.stop({ flush: release })
    if (release) await this.deps.lease.release(session.id)
  }

  private async beat(sessionId: string, view: StatusView): Promise<void> {
    try {
      await this.deps.repos.bot.heartbeat(heartbeatInput(sessionId, this.deps.lease.instanceId, view, this.errors.list()))
    } catch (error) {
      this.recordError('No pude escribir el latido', error)
    }
  }

  private recordError(message: string, error: unknown): void {
    this.deps.logger.error({ kind: this.deps.kind, err: errorMessage(error) }, message)
    this.errors.push(this.deps.clock.now(), `${message}: ${errorMessage(error)}`)
  }
}
