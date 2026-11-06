// La sesión real en su slot. Arranque: la cuenta de Binance (REST + user data stream) →
// reconciliación de lo que Binance tiene → `LiveSession` con la política real (lo adoptado ya
// está en la base, lo que Binance cerró llega como cierre encolado y los precios de REST
// entran como `onMarkTick`). Sin claves o con la sesión de otro entorno no habla con Binance:
// late en `off` diciendo qué falta y rechaza con ese motivo los comandos del dashboard (sin
// `LiveSession` nadie más los toma y `real_off` no vence).

import type { FundingEvent, MarkTick } from '@sereno/core'
import type { Scorer } from '@sereno/core/src/engine/types'
import type { Db, Repos, SessionRow } from '@sereno/db'
import type { BotPhase, RealGate } from '@sereno/shared'
import type { BinanceTradeRest } from '../binance/trade-rest'
import type { BotConfig } from '../config'
import type { CallBudget } from '../jobs/budget'
import type { EngineLane } from '../live/engine-lane'
import { NO_FLAGS, type StatusView } from '../live/heartbeat'
import type { LiveRest } from '../live/live-types'
import type { LiveStream, MarketStack } from '../live/market-stack'
import { MAX_COMMANDS_PER_TICK } from '../live/commands'
import { LiveSession, SessionClosedError } from '../live/session'
import { REAL_POLICY } from '../live/session-policy'
import type { OpenContext, SlotSession } from '../live/slot'
import type { Clock, TimerHandle } from '../live/timers'
import type { UniverseRefresh } from '../live/universe-refresh'
import type { Logger } from '../logger'
import type { UserStreamLike } from './account'
import { gateConfig, RealController } from './controller'
import { decideGate } from './gate'
import { createRealKit, type RealKit } from './kit'
import type { ReadinessSession, ReadinessWriter } from './readiness'
import type { RetryPolicy } from './retry'

// Lo del proceso para operar con plata real.
export interface RealProcess {
  config: BotConfig['real']
  // null sin claves de operación.
  trade: BinanceTradeRest | null
  // El user data stream de cada sesión.
  userStream: (trade: BinanceTradeRest) => UserStreamLike
  // Sólo en testnet: su propio mercado (sus precios no son los de mainnet). En mainnet usa el
  // stream y el REST de la de papel.
  market?: { rest: LiveRest; streamFactory: (symbols: string[]) => LiveStream }
  refreshUniverse: UniverseRefresh
  retry?: RetryPolicy
}

const COMMANDS_MS = 3_000

export interface RealSessionDeps {
  process: RealProcess
  row: SessionRow
  ctx: OpenContext
  db: Db
  repos: Repos
  stack: MarketStack
  readiness: ReadinessWriter
  clock: Clock
  logger: Logger
  budget: CallBudget
  instanceId: string
  warmupCandles: number
  scorer?: Scorer
}

export class RealSession implements SlotSession {
  private live: LiveSession | null = null
  private kit: RealKit | null = null
  private controller: RealController | null = null
  private closed = false
  private refusing: TimerHandle | null = null

  constructor(private readonly deps: RealSessionDeps) {}

  get id(): string {
    return this.deps.row.id
  }

  get phase(): BotPhase {
    if (this.unguarded()) return 'off'
    return this.live?.phase ?? 'starting'
  }

  async start(): Promise<void> {
    const { process, row, repos, stack, clock, logger, ctx } = this.deps
    const trade = process.trade
    if (this.unguarded() || !trade) {
      logger.warn({ sessionId: row.id, missing: this.gate().missing }, 'La sesión con plata real no puede hablar con Binance')
      this.refuseCommands(0)
      return
    }
    const rest = process.market?.rest ?? stack.rest
    this.kit = createRealKit({
      sessionId: row.id,
      trade,
      userStream: process.userStream(trade),
      repos,
      rest,
      clock,
      logger,
      openings: () => this.controller?.openings() ?? { allowed: false, detail: 'la sesión real todavía está arrancando' },
      onNote: (note) => this.controller?.note(note),
      ...(process.retry ? { retry: process.retry } : {}),
    })
    await this.kit.account.start()
    if (this.closed) throw new SessionClosedError()
    const live: { session: LiveSession | null } = { session: null }
    // El controlador existe antes que la sesión (es su extensión): llega a su carril por acá.
    const lane: EngineLane = {
      run(op, extra) {
        return requireLive(live.session).run(op, extra)
      },
      snapshot: () => requireLive(live.session).snapshot(),
    }
    const controller = new RealController({
      repos,
      sessionId: row.id,
      binanceEnv: row.binanceEnv ?? process.config.env,
      realStatus: row.realStatus ?? 'off',
      realChangedAt: row.realChangedAt?.getTime() ?? null,
      kit: this.kit,
      lane,
      clock,
      logger,
      config: gateConfig(process.config),
      readiness: this.deps.readiness,
      errors: ctx.errors,
    })
    this.controller = controller
    live.session = new LiveSession(
      {
        db: this.deps.db,
        repos,
        rest,
        clock,
        logger,
        market: stack.market,
        gate: stack.gate,
        funding: stack.funding,
        spreads: stack.spreads,
        feed: stack.feed('real'),
        budget: this.deps.budget,
        errors: ctx.errors,
        // Sin aprendizaje ni replays propios: la sesión real opera con lo que trae.
        hooks: {},
        instanceId: this.deps.instanceId,
        warmupCandles: this.deps.warmupCandles,
        lastFlags: ctx.lastFlags,
        ...(this.deps.scorer ? { scorer: this.deps.scorer } : {}),
        policy: REAL_POLICY,
        refreshUniverse: process.refreshUniverse,
        buildEngine: (b) => this.requireKit().buildEngine(b),
        extension: controller,
        onEnded: ctx.onEnded,
      },
      row,
    )
    this.live = live.session
    await live.session.start()
  }

  async stop({ flush }: { flush: boolean }): Promise<void> {
    this.closed = true
    if (this.refusing !== null) this.deps.clock.timers.clearTimeout(this.refusing)
    this.refusing = null
    await this.live?.stop({ flush })
    await this.kit?.stop()
  }

  status(): StatusView {
    if (this.live) return this.live.status()
    return {
      phase: this.phase,
      warmProgress: 0,
      universeSize: 0,
      lastCycleAt: null,
      settingsVersionApplied: null,
      degradedSymbols: [],
      flags: this.deps.ctx.lastFlags ?? NO_FLAGS,
      real: this.controller?.gate() ?? this.gate(),
    }
  }

  onMark(tick: MarkTick, funding: FundingEvent | null): void {
    this.live?.onMark(tick, funding)
  }

  markReconnecting(): void {
    this.live?.markReconnecting()
  }

  // Lo que la revisión de la cuenta necesita de la sesión.
  readinessSession(): ReadinessSession {
    const { row, process } = this.deps
    const snapshot = this.live?.currentSnapshot() ?? null
    return {
      id: row.id,
      env: row.binanceEnv ?? process.config.env,
      saldo: snapshot?.accounts.real.saldo ?? row.capitalInicial,
      usesMargin: (snapshot?.real.positions.length ?? 0) > 0,
    }
  }

  private gate(): RealGate {
    const { process, row } = this.deps
    return decideGate({
      enabled: process.config.enabled,
      keysPresent: process.trade !== null,
      env: process.config.env,
      checks: this.deps.readiness.latest,
      session: { realStatus: row.realStatus ?? 'off', binanceEnv: row.binanceEnv ?? process.config.env },
    })
  }

  // Cada `COMMANDS_MS`, como los toma `LiveSession`.
  private refuseCommands(ms: number): void {
    const { clock, repos, row, instanceId, logger } = this.deps
    this.refusing = clock.timers.setTimeout(() => {
      this.refusing = null
      const message = `No hice nada: esta sesión no habla con Binance (falta ${this.gate().missing.join(', ')}).`
      const refuse = async () => {
        await repos.commands.expireStale(row.id)
        for (let i = 0; i < MAX_COMMANDS_PER_TICK && !this.closed; i++) {
          const command = await repos.commands.claimNext(row.id, instanceId)
          if (!command) return
          await repos.commands.finish(command.id, { ok: false, message })
        }
      }
      void refuse()
        .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'No pude rechazar los comandos de la sesión real'))
        .finally(() => {
          if (!this.closed) this.refuseCommands(COMMANDS_MS)
        })
    }, ms)
  }

  private unguarded(): boolean {
    return this.gate().mode === 'unguarded'
  }

  private requireKit(): RealKit {
    if (!this.kit) throw new Error('La sesión real todavía no conectó con Binance')
    return this.kit
  }
}

function requireLive(session: LiveSession | null): LiveSession {
  if (!session) throw new Error('La sesión real todavía no tiene motor')
  return session
}
