// El proceso en vivo (spec §12): la simulación en papel y, si el proceso tiene con qué, la
// sesión con plata real, cada una en su slot (lease, latido y reintento propios). Los datos
// de mercado son del proceso (`MarketStack`): cambiar de sesión no los reinicia, y en mainnet
// las dos sesiones comparten el mismo stream.

import { randomUUID } from 'node:crypto'
import type { Scorer } from '@sereno/core/src/engine/types'
import { createRepos, type Db, type Repos, type SessionRow } from '@sereno/db'
import type { BotPhase } from '@sereno/shared'
import { WARMUP_WEIGHT_PER_MINUTE, weightBudget, type CallBudget } from '../jobs/budget'
import { errorMessage } from '../jobs/errors'
import { silentLogger, type Logger } from '../logger'
import { ReadinessWriter } from '../real/readiness'
import { RealSession, type RealProcess } from '../real/real-session'
import { buildEngine } from './engine-build'
import { Lease } from './lease'
import type { LiveHooks, LiveRest } from './live-types'
import { MarketStack, type LiveStream } from './market-stack'
import { DAY_MS, MINUTE_MS, Scheduler, SECOND_MS } from './scheduler'
import { LiveSession } from './session'
import { PAPER_POLICY } from './session-policy'
import { SessionSlot, type OpenContext } from './slot'
import { realClock, type Clock } from './timers'
import { refreshUniverse } from './universe-refresh'

export { RETRY_OPEN_MS, STALE_CLAIM_MS } from './slot'
export type { LiveStream } from './market-stack'

export const HEARTBEAT_MS = 10 * SECOND_MS
// El mmr y las comisiones de la cuenta, después del refresco de contratos de las 00:05 UTC:
// así entran las monedas que Binance listó ese día.
export const ACCOUNT_TIERS_OFFSET_MS = 10 * MINUTE_MS

export interface LiveDeps {
  db: Db
  rest: LiveRest
  // El stream necesita sus símbolos al crearse: se abre con el universo de la primera sesión.
  streamFactory: (symbols: string[]) => LiveStream
  clock?: Clock
  logger?: Logger
  instanceId?: string
  budget?: CallBudget
  hooks?: LiveHooks
  warmupCandles?: number
  scorer?: Scorer
  // La sesión con plata real; sin esto el proceso sólo opera la de papel.
  real?: RealProcess
}

export type SlotName = 'paper' | 'real'

export interface LiveRuntime {
  readonly instanceId: string
  status(slot?: SlotName): { phase: BotPhase | null; sessionId: string | null }
  // Espera a que terminen de arrancar las sesiones que se están tomando.
  ready(): Promise<void>
  // Apagado ordenado: guarda lo pendiente, último latido y suelta los leases.
  stop(): Promise<void>
}

export async function startLive(deps: LiveDeps): Promise<LiveRuntime> {
  const runtime = new Runtime(deps)
  await runtime.begin()
  return runtime
}

class Runtime implements LiveRuntime {
  readonly instanceId: string
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly repos: Repos
  private readonly lease: Lease
  private readonly scheduler: Scheduler
  private readonly budget: CallBudget
  private readonly stack: MarketStack
  private readonly paper: SessionSlot<LiveSession>
  private readonly real: { slot: SessionSlot<RealSession>; stack: MarketStack; readiness: ReadinessWriter } | null
  private stopping = false
  // Una corrida de los datos de la cuenta por vez, y la sesión para la que ya se pidieron.
  private accountRun: Promise<void> = Promise.resolve()
  private accountSession: string | null = null

  constructor(private readonly deps: LiveDeps) {
    this.instanceId = deps.instanceId ?? randomUUID()
    this.clock = deps.clock ?? realClock
    this.logger = deps.logger ?? silentLogger
    this.repos = createRepos(deps.db)
    this.lease = new Lease(this.repos.bot, this.instanceId)
    this.budget = deps.budget ?? weightBudget(WARMUP_WEIGHT_PER_MINUTE, this.clock.now)
    this.scheduler = new Scheduler({ clock: this.clock, onError: (job, error) => this.jobFailed(job, error) })
    this.stack = new MarketStack({ rest: deps.rest, streamFactory: deps.streamFactory, clock: this.clock, logger: this.logger, repos: this.repos, persistCandles: true })
    this.paper = new SessionSlot({
      kind: 'paper_live',
      repos: this.repos,
      lease: this.lease,
      clock: this.clock,
      logger: this.logger,
      idleMessage: 'No hay una simulación activa: espero a que se cree una',
      open: (row, ctx) => this.openPaper(row, ctx),
      // Una vez por sesión tomada (un arranque reintentado no los vuelve a pedir) y sin
      // esperarlos: con los contratos ya en el catálogo y sin frenar el arranque.
      onStarted: (session) => {
        if (this.accountSession === session.id) return
        this.accountSession = session.id
        void this.refreshAccount()
      },
    })
    this.real = deps.real ? this.realSide(deps.real) : null
    this.wire(this.stack)
  }

  async begin(): Promise<void> {
    await this.paper.tick()
    this.scheduler.add({ name: 'latido', period: HEARTBEAT_MS, run: () => this.paper.tick() })
    if (this.deps.hooks?.accountTiers) this.scheduler.add({ name: 'cuenta', period: DAY_MS, offset: ACCOUNT_TIERS_OFFSET_MS, run: () => this.refreshAccount() })
    const { real } = this
    if (!real) return
    // La revisión de la cuenta sin esperarla: Binance lento (o caído) nunca demora la de papel.
    // El latido sólo toca la base; el arranque de la sesión corre aparte (`ready`).
    void real.readiness.start(this.scheduler).catch((error: unknown) => real.slot.pushError(`No pude revisar la cuenta de Binance: ${errorMessage(error)}`))
    await real.slot.tick()
    this.scheduler.add({ name: 'latido real', period: HEARTBEAT_MS, run: () => real.slot.tick() })
  }

  status(slot: SlotName = 'paper'): { phase: BotPhase | null; sessionId: string | null } {
    if (slot === 'paper') return this.paper.status()
    return this.real?.slot.status() ?? { phase: null, sessionId: null }
  }

  async ready(): Promise<void> {
    await Promise.all([this.paper.ready(), this.real?.slot.ready()])
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.scheduler.stop()
    await Promise.all([this.paper.stop(), this.real?.slot.stop()])
    this.stack.stop()
    if (this.real && this.real.stack !== this.stack) this.real.stack.stop()
    // Al final: con Binance lento, los reintentos del cliente pueden tardar minutos, y un
    // `docker stop` mata el proceso antes. Lo de la sesión ya quedó guardado; la corrida
    // sólo escribe ajustes con su versión, así que terminar sin el lease no pisa nada.
    await this.accountRun
    this.logger.info('Bot detenido')
  }

  private openPaper(row: SessionRow, ctx: OpenContext): LiveSession {
    const { deps, stack } = this
    return new LiveSession(
      {
        db: deps.db,
        repos: this.repos,
        rest: deps.rest,
        clock: this.clock,
        logger: this.logger,
        market: stack.market,
        gate: stack.gate,
        funding: stack.funding,
        spreads: stack.spreads,
        feed: stack.feed('paper'),
        budget: this.budget,
        errors: ctx.errors,
        hooks: deps.hooks ?? {},
        instanceId: this.instanceId,
        warmupCandles: deps.warmupCandles ?? stack.market.warmupLimits['15m'],
        lastFlags: ctx.lastFlags,
        ...(deps.scorer ? { scorer: deps.scorer } : {}),
        policy: PAPER_POLICY,
        refreshUniverse: (input) => refreshUniverse({ rest: deps.rest, repos: this.repos, logger: this.logger }, input),
        buildEngine,
        onEnded: ctx.onEnded,
      },
      row,
    )
  }

  private realSide(process: RealProcess): NonNullable<Runtime['real']> {
    const stack = process.market
      ? new MarketStack({ rest: process.market.rest, streamFactory: process.market.streamFactory, clock: this.clock, logger: this.logger, repos: this.repos, persistCandles: false })
      : this.stack
    // La revisión de la cuenta corre siempre (también sin claves): el dashboard dice qué
    // falta leyendo su fila.
    const readiness = new ReadinessWriter({
      repos: this.repos,
      trade: process.trade,
      config: process.config,
      instanceId: this.instanceId,
      clock: this.clock,
      session: () => slot.current()?.readinessSession() ?? null,
    })
    const slot: SessionSlot<RealSession> = new SessionSlot({
      kind: 'live',
      repos: this.repos,
      lease: this.lease,
      clock: this.clock,
      logger: this.logger,
      idleMessage: 'No hay una sesión con plata real activa',
      open: (row, ctx) =>
        new RealSession({
          process,
          row,
          ctx,
          db: this.deps.db,
          repos: this.repos,
          stack,
          readiness,
          clock: this.clock,
          logger: this.logger,
          budget: this.budget,
          instanceId: this.instanceId,
          warmupCandles: this.deps.warmupCandles ?? stack.market.warmupLimits['15m'],
          ...(this.deps.scorer ? { scorer: this.deps.scorer } : {}),
        }),
    })
    if (stack !== this.stack) this.wire(stack)
    return { slot, stack, readiness }
  }

  // Cada precio del stream va a las sesiones que lo usan; cada corte, también.
  private wire(stack: MarketStack): void {
    const sessions = (): { onMark: LiveSession['onMark']; markReconnecting(): void }[] => {
      const out: { onMark: LiveSession['onMark']; markReconnecting(): void }[] = []
      if (stack === this.stack) {
        const paper = this.paper.current()
        if (paper) out.push(paper)
      }
      const real = this.real?.stack === stack ? this.real.slot.current() : null
      if (real) out.push(real)
      return out
    }
    stack.onMark((tick, funding) => {
      for (const session of sessions()) session.onMark(tick, funding)
    })
    stack.onReconnecting(() => {
      for (const session of sessions()) session.markReconnecting()
    })
    stack.onError((message) => {
      if (stack === this.stack) this.paper.pushError(message)
      if (this.real?.stack === stack) this.real.slot.pushError(message)
    })
  }

  // Para la sesión de papel que se opera; los errores que deje se muestran sólo mientras
  // siga siéndolo.
  private refreshAccount(): Promise<void> {
    const hook = this.deps.hooks?.accountTiers
    const session = this.paper.current()
    if (!hook || !session || this.stopping) return this.accountRun
    const sessionId = session.id
    const reportError = (message: string): void => {
      if (this.paper.current()?.id === sessionId) this.paper.pushError(message)
    }
    this.accountRun = this.accountRun
      .then(() => hook({ sessionId, repos: this.repos, reportError }))
      .catch((error: unknown) => this.jobFailed('cuenta', error))
    return this.accountRun
  }

  // Los trabajos del proceso: la revisión de la cuenta es de la real; el resto, de papel.
  private jobFailed(job: string, error: unknown): void {
    const message = `Falló el trabajo ${job}`
    this.logger.error({ err: errorMessage(error) }, message)
    const slot = job === 'real_readiness' && this.real ? this.real.slot : this.paper
    slot.pushError(`${message}: ${errorMessage(error)}`)
  }
}
