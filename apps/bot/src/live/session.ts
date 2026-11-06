// Una sesión en vivo con el lease tomado: su motor, su persistencia y sus trabajos
// (spec §12). Las operaciones sobre el motor (ciclos, precios, funding, comandos) pasan
// por un carril de a una, y lo que cada una produce se guarda en orden. La misma clase
// corre la sesión en papel y la real: lo que cambia lo dicen `policy`, `buildEngine` y, en
// la real, `extension` (Binance: reconciliación, gating, tope de pérdida).

import type { BtcContext, EngineEvent, FundingEvent, MarkTick, Position, SymbolInfo } from '@sereno/core'
import type { TradingEngine } from '@sereno/core/src/engine/engine'
import type { EngineFailure, EngineSnapshot, Scorer } from '@sereno/core/src/engine/types'
import { SessionArchivedError, type BotFlags, type Db, type Repos, type SessionRow, type SymbolRecord } from '@sereno/db'
import type { BotPhase, RealGate, Settings } from '@sereno/shared'
import { INTERVAL_MS } from '../binance/types'
import type { CallBudget } from '../jobs/budget'
import { cleanup } from '../jobs/cleanup'
import { errorMessage } from '../jobs/errors'
import { FUTURES_POLL_INTERVAL_MS } from '../jobs/futures-data'
import type { Logger } from '../logger'
import { processCommands, type RealCommandDeps } from './commands'
import type { CandleGate } from './cycle'
import { planFromSnapshot, type EngineBuild } from './engine-build'
import type { EngineLane, ExtraWrite } from './engine-lane'
import type { FundingTracker } from './funding'
import { missedFunding } from './funding-backfill'
import { FundingRetries } from './funding-retry'
import { flagsOf, NO_FLAGS, type RecentErrors, type StatusView } from './heartbeat'
import { infosFrom } from './infos'
import type { HookContext, LiveHooks, LiveRest, MarketFeed } from './live-types'
import type { MarketData } from './market-data'
import { marketSymbols } from './market-snapshot'
import { Persister, type PersistBatch } from './persist'
import { DAY_MS, HOUR_MS, MINUTE_MS, Scheduler, SECOND_MS, WEEK_SUNDAY_0030_OFFSET_MS } from './scheduler'
import { loadSession, type RestoreContext } from './session-load'
import { degradedSymbols, loadFutures, marksFromRest, refreshFutures, saveCycleCandles, warmSymbols } from './session-market'
import type { SessionPolicy } from './session-policy'
import { applyThrough, infosKey, missedPause, rebuildSettings, resumedBetween } from './session-settings'
import { saveObservedSpreads, sampleSpreads, SPREAD_SAMPLE_MS, type SpreadSampler } from './spreads'
import type { Clock } from './timers'
import type { Universe, UniverseRefresh } from './universe-refresh'
import { BTC_SYMBOL } from './warmup'

const CANDLE_15M_MS = INTERVAL_MS['15m']

// Lo que agrega la sesión real (`real/controller.ts`).
export interface SessionExtension {
  // Antes de leer las abiertas de la base: reconcilia con Binance y adopta.
  beforeRestore(ctx: RestoreContext): Promise<void>
  // Con el motor retomado, los precios de REST entregados y los comandos en marcha.
  started(): Promise<void>
  // Cada 3 s, antes de los comandos.
  poll(): Promise<void>
  // Después de cada operación del motor, con lo que produjo, dentro del carril: lo que
  // devuelve va en la misma transacción que esos eventos.
  afterOp(events: readonly EngineEvent[]): Promise<ExtraWrite | undefined>
  gate(): RealGate
  // Lo que necesita `real_off`.
  commands(): RealCommandDeps
  // Deja de trabajar: después de esto no encola nada más.
  stop(): void
}

export interface SessionDeps {
  db: Db
  repos: Repos
  rest: LiveRest
  clock: Clock
  logger: Logger
  market: MarketData
  gate: CandleGate
  funding: FundingTracker
  spreads: SpreadSampler
  feed: MarketFeed
  budget: CallBudget
  errors: RecentErrors
  hooks: LiveHooks
  instanceId: string
  warmupCandles: number
  // Los cortes del último latido que quedó guardado (null si la sesión nunca tuvo uno):
  // de ahí se retoma la pausa por drawdown, y es lo que se informa hasta tener motor.
  lastFlags: BotFlags | null
  scorer?: Scorer
  policy: SessionPolicy
  refreshUniverse: UniverseRefresh
  // Arma el motor al retomar y al rehacerlo por ajustes (en papel `buildEngine`, en la real
  // sobre el adaptador de Binance).
  buildEngine: (b: EngineBuild) => Promise<TradingEngine>
  extension?: SessionExtension
  // La sesión terminó (la archivaron): el runtime busca la nueva.
  onEnded: (session: LiveSession) => void
}

// `always`: se guarda aunque no haya eventos (un comando puede cambiar sólo el estado,
// como volver a usar el capital blindado, y termina recién cuando eso quedó escrito).
type BatchOptions = Pick<PersistBatch, 'cycleT' | 'minute' | 'extra'> & { always?: boolean }

export class SessionClosedError extends Error {
  constructor() {
    super('La sesión ya no está operando')
  }
}

export class LiveSession implements EngineLane {
  phase: BotPhase = 'starting'
  private engine: TradingEngine | null = null
  private settings: Settings | null = null
  private settingsVersion: number | null = null
  private universe: Universe = { symbols: [], delisted: [] }
  private records: SymbolRecord[] = []
  private infos: Record<string, SymbolInfo> = {}
  private readonly persister: Persister
  private readonly scheduler: Scheduler
  private readonly events: EngineEvent[] = []
  private lane: Promise<unknown> = Promise.resolve()
  private warmed = 0
  private lastCycleAt: number | null = null
  private lastBtc: BtcContext | null = null
  private feedSince: number | null = null
  private readonly sPrime = new Map<string, number>()
  private readonly reconcilePending = new Set<string>()
  // Última liquidación de funding cobrada por moneda: la del stream y la del historial de
  // REST no se cobran dos veces. Sólo avanza con un cobro exitoso: una liquidación
  // inválida queda en `fundingRetries`.
  private readonly fundedAt = new Map<string, number>()
  private readonly fundingRetries = new FundingRetries()
  private closed = false
  private discard = false

  constructor(
    private readonly deps: SessionDeps,
    readonly row: SessionRow,
  ) {
    this.persister = new Persister({
      db: deps.db,
      sessionId: row.id,
      onDiscard: (error) => this.recordError('La base rechazó un lote varias veces y lo descarté', error),
      onStuckOpen: (positionId, error) => this.recordError(`La posición ${positionId} quedó abierta en la base y el motor ya la cerró`, error),
      fundingReported: deps.policy.kind === 'real',
    })
    this.scheduler = new Scheduler({
      clock: deps.clock,
      // Un trabajo que estaba en curso cuando la sesión dejó de operarse no es un error.
      onError: (job, error) => {
        if (!sessionEnded(error)) this.recordError(`Falló el trabajo ${job}`, error)
      },
    })
  }

  get id(): string {
    return this.row.id
  }

  // Retoma la sesión, calienta velas y arranca los trabajos. Los comandos se atienden
  // desde que el motor existe, también mientras calienta.
  async start(): Promise<void> {
    const { deps } = this
    const { extension } = deps
    const loaded = await loadSession(
      {
        repos: deps.repos,
        logger: deps.logger,
        refreshUniverse: deps.refreshUniverse,
        buildEngine: deps.buildEngine,
        ...(extension ? { beforeRestore: (ctx: RestoreContext) => extension.beforeRestore(ctx) } : {}),
        now: deps.clock.now,
        sink: (event) => this.events.push(event),
        onFailure: (failure) => this.onEngineFailure(failure),
        lastFlags: deps.lastFlags,
        ...(deps.scorer ? { scorer: deps.scorer } : {}),
      },
      this.row,
    )
    this.assertOpen()
    this.engine = loaded.engine
    this.settings = loaded.settings
    this.settingsVersion = loaded.settingsVersion
    this.universe = loaded.universe
    this.records = loaded.records
    this.infos = loaded.infos
    await this.reconcileFromRest()
    this.scheduler.add({ name: 'comandos', period: 3 * SECOND_MS, run: () => this.commandsTick() })
    this.scheduler.add({ name: 'equity', period: MINUTE_MS, run: () => this.equityTick() })
    await extension?.started()
    this.assertOpen()

    this.phase = 'warming'
    // Las abiertas reciben precio desde ya: el calentamiento puede tardar minutos (por el
    // presupuesto de REST) y un stop cruzado en ese rato tiene que cerrar en su momento.
    const open = this.openSymbols()
    if (open.length > 0) deps.feed.want(open)
    await this.warm(this.tracked())
    this.assertOpen()
    await this.futuresTick(deps.clock.now()).catch((error: unknown) => this.recordError('No pude traer los datos de futuros', error))
    deps.feed.want([...this.tracked(), BTC_SYMBOL])
    deps.feed.keepOnly([...this.tracked(), BTC_SYMBOL])
    this.feedSince = deps.clock.now()

    this.scheduler.add({ name: 'ciclo', period: CANDLE_15M_MS, run: (t) => this.cycle(t) })
    this.scheduler.add({ name: 'futuros', period: FUTURES_POLL_INTERVAL_MS, run: (at) => this.futuresTick(at) })
    this.scheduler.add({ name: 'mercado', period: 5 * SECOND_MS, run: () => this.marketTick() })
    if (deps.policy.sampleSpreads) this.scheduler.add({ name: 'libro', period: SPREAD_SAMPLE_MS, run: (at) => sampleSpreads(deps.rest, deps.spreads, this.tracked(), at) })
    this.scheduler.add({ name: 'universo', period: DAY_MS, offset: 5 * MINUTE_MS, run: () => this.dailyTick() })
    const { forwardReturns, weekly } = deps.hooks
    if (forwardReturns) this.scheduler.add({ name: 'retornos', period: HOUR_MS, offset: 2 * MINUTE_MS, run: () => forwardReturns(this.hookContext()) })
    if (weekly) this.scheduler.add({ name: 'semanal', period: 7 * DAY_MS, offset: WEEK_SUNDAY_0030_OFFSET_MS, run: () => weekly(this.hookContext()) })
    this.phase = this.currentSettings().pause.paused ? 'paused' : 'live'
    deps.logger.info({ sessionId: this.id, universe: this.universe.symbols }, 'Sesión en vivo')
  }

  // Deja de operar. Con `flush`, termina lo encolado y lo guarda; sin él (lease perdido:
  // otra instancia puede estar operando), descarta lo que falte guardar.
  async stop({ flush }: { flush: boolean }): Promise<void> {
    this.closed = true
    this.scheduler.stop()
    this.deps.extension?.stop()
    if (!flush) this.discard = true
    await this.lane.catch(() => undefined)
    if (flush) await this.persister.idle()
  }

  status(): StatusView {
    const now = this.deps.clock.now()
    const engine = this.engine
    return {
      phase: this.phase,
      warmProgress: this.warmed,
      universeSize: this.universe.symbols.length,
      lastCycleAt: this.lastCycleAt,
      settingsVersionApplied: this.settingsVersion,
      degradedSymbols: [...this.degraded(now).keys()],
      flags: engine && this.settings ? flagsOf(engine.snapshot(), this.settings, this.lastBtc, now) : (this.deps.lastFlags ?? NO_FLAGS),
      ...(this.deps.extension ? { real: this.deps.extension.gate() } : {}),
    }
  }

  // ---------- datos del stream (los entrega el runtime) ----------

  onMark(tick: MarkTick, funding: FundingEvent | null): void {
    if (!this.engine || this.closed) return
    const { marketFunding } = this.deps.policy
    if (funding && marketFunding) this.fire((engine) => this.fund(engine, funding))
    if (marketFunding && this.fundingRetries.has(tick.symbol)) this.fire((engine) => this.retryFunding(engine, tick))
    if (this.reconcilePending.delete(tick.symbol)) this.fire((engine) => engine.reconcile([tick]))
    else this.fire((engine) => engine.onMarkTick(tick))
  }

  // El stream se cortó: el primer precio de cada abierta al volver la reevalúa como
  // después de un reinicio (un stop que quedó atrás cierra como no ejecutado).
  markReconnecting(): void {
    if (this.deps.policy.afterGap !== 'engine_reconcile') return
    for (const symbol of this.openSymbols()) this.reconcilePending.add(symbol)
  }

  // ---------- carril del motor ----------

  async run<T>(op: (engine: TradingEngine) => Promise<T>, extra?: (result: T) => ExtraWrite | undefined): Promise<T> {
    const { result, saved } = await this.enqueue(op, (r) => {
      const write = extra?.(r)
      return write ? { extra: write, always: true } : { always: true }
    })
    await saved
    return result
  }

  snapshot(): EngineSnapshot {
    return this.requireEngine().snapshot()
  }

  // null mientras no tiene motor.
  currentSnapshot(): EngineSnapshot | null {
    return this.engine?.snapshot() ?? null
  }

  private enqueue<T>(op: (engine: TradingEngine) => Promise<T>, options?: (result: T) => BatchOptions): Promise<{ result: T; saved: Promise<void> }> {
    if (this.closed) return Promise.reject(new SessionClosedError())
    const task = this.lane.then(async () => {
      const result = await op(this.requireEngine())
      const { always = false, extra, ...batch } = options?.(result) ?? {}
      const events = this.events.splice(0)
      const added = events.length > 0 ? await this.deps.extension?.afterOp(events) : undefined
      const write = joinWrites(extra, added)
      const needed = always || events.length > 0 || batch.minute === true || write !== undefined
      const saved = needed ? this.save({ events, snapshot: this.requireEngine().snapshot(), ...batch, ...(write ? { extra: write } : {}) }) : Promise.resolve()
      return { result, saved }
    })
    this.lane = task.catch(() => undefined)
    return task
  }

  // Para lo que llega del stream: nadie espera el resultado, los errores se registran (los
  // de guardar ya los registra `save`).
  private fire(op: (engine: TradingEngine) => Promise<unknown>): void {
    this.enqueue(op).then(
      ({ saved }) => saved.catch(() => undefined),
      (error: unknown) => {
        if (!sessionEnded(error)) this.recordError('Falló una operación del motor', error)
      },
    )
  }

  private save(batch: PersistBatch): Promise<void> {
    if (this.discard) return Promise.resolve()
    const saved = this.persister.write(batch)
    saved.catch((error: unknown) => {
      if (error instanceof SessionArchivedError) this.end()
      else this.recordError('No pude guardar lo último; lo reintento con lo próximo', error)
    })
    return saved
  }

  private end(): void {
    if (this.closed) return
    this.closed = true
    this.scheduler.stop()
    this.deps.extension?.stop()
    this.deps.logger.warn({ sessionId: this.id }, 'La sesión se archivó: dejo de operarla')
    this.deps.onEnded(this)
  }

  // ---------- trabajos ----------

  private async cycle(t: number): Promise<void> {
    const { market, gate, clock } = this.deps
    const symbols = this.universe.symbols.filter((s) => market.isWarm(s) && this.infos[s] !== undefined)
    const missingSymbols = await gate.wait(t, symbols, this.currentSettings().entry.decisionDeadlineMs)
    const btc = market.btcContext(t)
    const views = symbols.flatMap((s) => {
      const view = market.view(s, t, this.infos[s]!, btc)
      return view ? [view] : []
    })
    const stale = this.degraded(clock.now())
    const degraded = symbols.filter((s) => stale.has(s))
    const { result } = await this.enqueue(
      (engine) => engine.onCandleClose(views, { missingSymbols, degraded, delisted: this.universe.delisted }),
      () => ({ cycleT: t }),
    )
    this.lastCycleAt = t
    this.lastBtc = btc
    for (const d of result.decisions) this.sPrime.set(d.symbol, d.composite.Sprime)
    if (!this.deps.policy.persistCandles) return
    await saveCycleCandles(this.deps, t, symbols).catch((error: unknown) => this.recordError('No pude guardar las velas del ciclo', error))
  }

  private async commandsTick(): Promise<void> {
    await this.pollSettings()
    const { deps } = this
    await deps.extension?.poll()
    await processCommands({
      sessionId: this.id,
      instanceId: deps.instanceId,
      repos: deps.repos,
      now: deps.clock.now,
      lane: this,
      settings: () => this.currentSettings(),
      markAge: (symbol) => {
        const tick = deps.market.mark(symbol)
        return tick ? deps.clock.now() - tick.at : null
      },
      hooks: deps.hooks,
      logger: deps.logger,
      ...(deps.extension ? { real: deps.extension.commands() } : {}),
    })
  }

  // Espera a que el punto quede guardado (una corrida no se superpone con la siguiente);
  // si no se pudo, ya lo registró `save` y se reintenta con el próximo lote.
  private async equityTick(): Promise<void> {
    const { saved } = await this.enqueue(async () => undefined, () => ({ minute: true }))
    await saved.catch(() => undefined)
  }

  private async marketTick(): Promise<void> {
    const now = this.deps.clock.now()
    const snapshot = this.snapshot()
    const symbols = marketSymbols({
      now,
      symbols: this.universe.symbols,
      market: this.deps.market,
      engine: snapshot,
      sPrime: this.sPrime,
      theta: snapshot.learning.params.theta,
      degraded: this.degraded(now),
    })
    await this.deps.repos.market.upsert(this.id, symbols)
  }

  // La real lee lo que la de papel trajo y guardó.
  private async futuresTick(at: number): Promise<void> {
    if (this.deps.policy.pollFutures) await refreshFutures(this.deps, this.tracked(), at)
    else await loadFutures(this.deps, this.tracked(), at)
  }

  // El medio spread observado va antes del universo: los contratos nuevos del simulador ya lo usan.
  private async dailyTick(): Promise<void> {
    const { deps } = this
    const { policy } = deps
    deps.market.trim()
    if (policy.sampleSpreads) await saveObservedSpreads(deps.repos, deps.spreads, this.tracked(), deps.clock.now())
    await this.refreshUniverse()
    if (policy.cleanup) await cleanup({ repos: deps.repos, now: deps.clock.now, logger: deps.logger })
  }

  // ---------- ajustes, universo y motor ----------

  private async pollSettings(): Promise<void> {
    const row = await this.deps.repos.settings.get(this.id)
    const applied = this.settingsVersion
    if (!row || applied === null || row.version === applied) return
    const previous = this.currentSettings()
    const next = row.config
    const missed = await missedPause(this.deps.repos, this.id, { previous, next, applied, version: row.version })
    if (JSON.stringify(previous.risk) !== JSON.stringify(next.risk)) await this.rebuild(next, this.records, missed)
    else await this.enqueue((engine) => applyThrough(engine, next, missed))
    this.settings = next
    this.settingsVersion = row.version
    if (this.phase === 'live' || this.phase === 'paused') this.phase = next.pause.paused ? 'paused' : 'live'
    this.deps.logger.info({ version: row.version, paused: next.pause.paused }, 'Ajustes aplicados')
    if (JSON.stringify(previous.universe) !== JSON.stringify(next.universe)) {
      this.refreshUniverse().catch((error: unknown) => this.recordError('No pude recalcular el universo', error))
    }
  }

  private async refreshUniverse(): Promise<void> {
    const { deps } = this
    const settings = this.currentSettings()
    const { universe, records } = await deps.refreshUniverse({ sessionId: this.id, settings, openSymbols: this.openSymbols(), now: deps.clock.now() })
    const relevant = [...new Set([...universe.symbols, ...this.openSymbols()])]
    const before = infosKey(this.infos, relevant)
    if (infosKey(infosFrom(records, settings.risk), relevant) !== before) await this.rebuild(settings, records)
    this.records = records
    this.universe = universe
    await this.warm(this.tracked())
    deps.feed.want([...this.tracked(), BTC_SYMBOL])
    deps.feed.keepOnly([...this.tracked(), BTC_SYMBOL])
  }

  // Rehace el motor cuando cambia algo que el simulador fija al crearse (comisiones,
  // slippage, mmr, contratos). El estado sale del snapshot del motor actual; las abiertas
  // reciben enseguida la última marca conocida (y con ella sus órdenes). Si no se puede
  // (un margen que ya no entra en el saldo, un contrato que el simulador rechaza), sigue
  // el motor anterior.
  private async rebuild(settings: Settings, records: SymbolRecord[], missed: Settings['pause'] | null = null): Promise<void> {
    const resumed = resumedBetween(this.currentSettings(), settings, missed)
    await this.enqueue(async (old) => {
      const snapshot = old.snapshot()
      const infos = infosFrom(records, settings.risk)
      try {
        const engine = await this.deps.buildEngine({
          sessionId: this.id,
          capitalInicial: this.row.capitalInicial,
          settings: rebuildSettings(settings, { resumed, drawdownPaused: snapshot.real.guard.drawdownPaused }),
          learning: snapshot.learning,
          plan: planFromSnapshot(snapshot),
          infos,
          clock: this.deps.clock.now,
          sink: (event) => this.events.push(event),
          onFailure: (failure) => this.onEngineFailure(failure),
          logger: this.deps.logger,
          ...(this.deps.scorer ? { scorer: this.deps.scorer } : {}),
        })
        this.engine = engine
        this.infos = infos
      } catch (error) {
        this.recordError('No pude rehacer el motor con los ajustes nuevos; sigo con los anteriores', error)
        await applyThrough(old, settings, missed)
        return
      }
      for (const symbol of this.openSymbols()) {
        const tick = this.deps.market.mark(symbol)
        if (tick) await this.requireEngine().onMarkTick(tick)
      }
    })
  }

  // Precio actual por REST al retomar: las abiertas cuyo stop quedó atrás mientras el bot
  // no estaba cierran como "stop no ejecutado por bot sin conexión" (spec §12).
  private async reconcileFromRest(): Promise<void> {
    const { rest, market, funding, clock, policy } = this.deps
    const now = clock.now()
    const ticks = await marksFromRest(rest, now)
    const tracked = new Set([...this.tracked(), BTC_SYMBOL])
    for (const tick of ticks) {
      if (!tracked.has(tick.symbol)) continue
      market.addMark(tick, now)
      funding.note(tick)
    }
    const open = new Set(this.openSymbols())
    const toReconcile = ticks.filter((t) => open.has(t.symbol))
    // El funding de mientras no estaba va antes: las abiertas lo pagaron hasta ahora.
    const missed = policy.marketFunding
      ? await missedFunding({ repos: this.deps.repos, rest }, this.openPositions(), now).catch((error: unknown) => {
          this.recordError('No pude cobrar el funding que venció con el bot apagado', error)
          return []
        })
      : []
    const { saved } = await this.enqueue(async (engine) => {
      for (const event of missed) await this.fund(engine, event)
      if (policy.afterGap === 'engine_reconcile') return engine.reconcile(toReconcile)
      for (const tick of toReconcile) await engine.onMarkTick(tick)
    })
    await saved
  }

  private async fund(engine: TradingEngine, event: FundingEvent): Promise<void> {
    if (event.at <= (this.fundedAt.get(event.symbol) ?? Number.NEGATIVE_INFINITY)) return
    if (await engine.onFunding(event)) this.markFunded(event)
    else this.fundingRetries.failed(event)
  }

  // El funding que llegó inválido, otra vez con la marca de este tick (ver `funding-retry.ts`).
  private async retryFunding(engine: TradingEngine, tick: MarkTick): Promise<void> {
    for (const { event, last } of this.fundingRetries.take(tick, this.openPositions())) {
      if (await engine.onFunding(event)) {
        this.markFunded(event)
        continue
      }
      this.fundingRetries.failed(event)
      if (last) this.recordError(`Dejé de reintentar el funding de ${event.symbol}`, new Error(`la liquidación de ${new Date(event.at).toISOString()} quedó sin cobrar`))
    }
  }

  private markFunded(event: FundingEvent): void {
    this.fundedAt.set(event.symbol, Math.max(this.fundedAt.get(event.symbol) ?? Number.NEGATIVE_INFINITY, event.at))
    this.fundingRetries.charged(event)
  }

  private async warm(symbols: readonly string[]): Promise<void> {
    const { market, rest, clock, logger, budget, warmupCandles, policy } = this.deps
    const repos = policy.persistCandles ? this.deps.repos : NO_CANDLES
    const failed = await warmSymbols({ market, rest, repos, now: clock.now, logger, budget }, symbols, warmupCandles, (ready) => {
      this.warmed = ready
    })
    for (const { symbol, error } of failed) this.recordError(`No pude calentar ${symbol}: queda degradada`, new Error(error))
  }

  // ---------- apoyo ----------

  // Universo más las abiertas (las de la sombra también necesitan precio).
  private tracked(): string[] {
    return [...new Set([...this.universe.symbols, ...this.openSymbols()])]
  }

  private openSymbols(): string[] {
    return [...new Set(this.openPositions().map((p) => p.symbol))]
  }

  // Reales y de la sombra.
  private openPositions(): Position[] {
    if (!this.engine) return []
    const snapshot = this.engine.snapshot()
    return [...snapshot.real.positions, ...(snapshot.shadow?.positions ?? [])].map((s) => s.position)
  }

  private degraded(now: number): Map<string, number> {
    return degradedSymbols(this.deps.market, this.universe.symbols, this.feedSince, now)
  }

  private hookContext(): HookContext {
    return {
      sessionId: this.id,
      repos: this.deps.repos,
      now: this.deps.clock.now(),
      settings: this.currentSettings(),
      learning: () => this.requireEngine().snapshot().learning,
      updateLearning: async (update) => {
        await this.run(
          async (engine) => {
            const current = engine.snapshot().learning
            const next = update(current)
            if (next.state !== current) await engine.applyLearning(next.state)
            return next.log
          },
          (log) => (log.length > 0 ? (repos) => repos.learning.appendLog(this.id, log) : undefined),
        )
      },
    }
  }

  private onEngineFailure(failure: EngineFailure): void {
    const context = failure.operation === 'protect' ? `${failure.operation}:${failure.order}` : failure.operation
    this.deps.logger.warn({ failure: context, symbol: failure.symbol, err: errorMessage(failure.error) }, 'El motor salteó una operación')
    this.deps.errors.push(failure.at, `${failure.symbol}: ${errorMessage(failure.error)}`, context)
  }

  private recordError(message: string, error: unknown): void {
    this.deps.logger.error({ sessionId: this.id, err: errorMessage(error) }, message)
    this.deps.errors.push(this.deps.clock.now(), `${message}: ${errorMessage(error)}`)
  }

  private currentSettings(): Settings {
    if (!this.settings) throw new Error('La sesión todavía no cargó sus ajustes')
    return this.settings
  }

  private requireEngine(): TradingEngine {
    if (!this.engine) throw new Error('La sesión todavía no tiene motor')
    return this.engine
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError()
  }
}

// Sin `persistCandles`: lo que se calienta sólo vive en memoria.
const NO_CANDLES = { candles: { upsertMany: async () => undefined } }

function joinWrites(a: ExtraWrite | undefined, b: ExtraWrite | undefined): ExtraWrite | undefined {
  if (!a || !b) return a ?? b
  return async (repos) => {
    await a(repos)
    await b(repos)
  }
}

// La sesión dejó de operarse (la archivaron, perdió el lease o se apaga el proceso).
function sessionEnded(error: unknown): boolean {
  return error instanceof SessionClosedError || error instanceof SessionArchivedError
}
