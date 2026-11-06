// Las piezas de Binance de una sesión real: la cuenta (REST + user data stream), los ids de
// cliente, el adaptador del motor, la reconciliación y el cobro de funding. Viven lo que vive
// la sesión en el proceso. Rehacer el motor por ajustes o contratos lo arma sobre el mismo
// adaptador: una apertura en duda, un cierre a medias o una desaparecida que se olvidaran
// dejarían una posición del bot sin stop o un cierre por más de lo suyo.

import { TradingEngine } from '@sereno/core/src/engine/engine'
import type { FundingApplied } from '@sereno/core/src/exchange/types'
import { atr } from '@sereno/core/src/indicators/atr'
import type { Repos } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import type { BinanceTradeRest } from '../binance/trade-rest'
import { errorMessage } from '../jobs/errors'
import { liveIdPrefix, sessionAccount, type EngineBuild } from '../live/engine-build'
import type { RestoreContext } from '../live/session-load'
import type { Clock } from '../live/timers'
import type { Logger } from '../logger'
import { RealAccount, type UserStreamLike } from './account'
import { cancelArchivedAlgos } from './archived-algos'
import { ClientIds } from './client-id'
import { BinanceFuturesExchange, type AtStart, type OpeningsGate, type RealNote } from './exchange'
import { FundingCollector } from './funding'
import { reconcileAtStart, Reconciler, type StartReconcile } from './reconcile'
import { DEFAULT_RETRY, type RetryPolicy } from './retry'

// Velas de 1h para el ATR del stop de una adoptada: las 14 del período y margen.
const ATR_CANDLES = 30

export interface RealKitDeps {
  sessionId: string
  trade: BinanceTradeRest
  userStream: UserStreamLike
  repos: Repos
  // Las velas de 1h para el stop de una posición adoptada.
  rest: Pick<BinanceRest, 'klines'>
  clock: Clock
  logger: Logger
  // Se consultan en cada apertura y con cada nota: los decide el controlador.
  openings: () => OpeningsGate
  onNote: (note: RealNote) => void
  retry?: RetryPolicy
}

export interface RealKit {
  readonly trade: BinanceTradeRest
  readonly account: RealAccount
  readonly ids: ClientIds
  // El adaptador del motor (uno por sesión, también al rehacer el motor).
  readonly exchange: BinanceFuturesExchange
  // Antes de restaurar: lo que Binance cerró, adoptó o no muestra (lo adoptado queda en la base),
  // y los stops que dejó una sesión real archivada.
  reconcileAtStart(ctx: RestoreContext): Promise<StartReconcile>
  buildEngine(b: EngineBuild): Promise<TradingEngine>
  // Con el motor retomado: reconciliación periódica y funding desde `since`.
  watch(since: number, onFunding: (applied: FundingApplied[]) => void): void
  stop(): Promise<void>
}

// Conecta la cuenta (espera la primera sincronización) y deja el resto listo.
export async function buildRealKit(deps: RealKitDeps): Promise<RealKit> {
  const kit = createRealKit(deps)
  await kit.account.start()
  return kit
}

// Sin conectar: quien la arranca puede pararla mientras espera a Binance.
export function createRealKit(deps: RealKitDeps): RealKit {
  return new Kit(deps)
}

class Kit implements RealKit {
  readonly trade: BinanceTradeRest
  readonly account: RealAccount
  readonly ids: ClientIds
  private current: BinanceFuturesExchange | null = null
  private atStart: AtStart | null = null
  private reconciler: Reconciler | null = null
  private funding: FundingCollector | null = null
  private offFunding: (() => void) | null = null

  constructor(private readonly deps: RealKitDeps) {
    this.trade = deps.trade
    this.account = new RealAccount({ trade: deps.trade, stream: deps.userStream, sessionId: deps.sessionId, clock: deps.clock, logger: deps.logger })
    this.ids = new ClientIds(deps.sessionId, deps.clock.now)
  }

  get exchange(): BinanceFuturesExchange {
    if (!this.current) throw new Error('La sesión real todavía no tiene motor')
    return this.current
  }

  async reconcileAtStart(ctx: RestoreContext): Promise<StartReconcile> {
    const { deps } = this
    const result = await reconcileAtStart({
      repos: deps.repos,
      account: this.account,
      trade: deps.trade,
      stops: { trade: deps.trade, ids: this.ids, clock: deps.clock, delaysMs: (deps.retry ?? DEFAULT_RETRY).delaysMs },
      sessionId: deps.sessionId,
      infos: ctx.infos,
      atr1h: (symbol) => this.atr1h(symbol, ctx.now),
      settings: ctx.settings,
      now: ctx.now,
    })
    result.notes.push(...(await cancelArchivedAlgos({ repos: deps.repos, trade: deps.trade, account: this.account, sessionId: deps.sessionId, logger: deps.logger })))
    this.atStart = { pendingCloses: result.pendingCloses, vanished: result.vanished }
    return result
  }

  // Sin sombra: la sesión real no compara contra otra configuración. El primer motor arma el
  // adaptador (con lo encontrado al arrancar); los siguientes lo apuntan a los contratos y la
  // comisión nuevos, y la billetera sigue la del adaptador. Si el motor nuevo no se puede
  // retomar, sigue el anterior con el adaptador como estaba.
  async buildEngine(b: EngineBuild): Promise<TradingEngine> {
    const previous = this.current
    const exchange = previous ?? this.createExchange(b)
    const undo = previous ? previous.retarget({ infos: b.infos, takerFeeRate: b.settings.risk.takerFeeRate }) : () => exchange.detach()
    const engine = new TradingEngine({
      exchange,
      account: sessionAccount(b, b.plan.real),
      settings: b.settings,
      learning: b.learning,
      clock: b.clock,
      sink: b.sink,
      onFailure: b.onFailure,
      idPrefix: liveIdPrefix(b.sessionId),
      // Al 100% el tope de pérdida es "no perder más que lo asignado", no "sin tope".
      realMoney: true,
      ...(b.scorer ? { scorer: b.scorer } : {}),
    })
    try {
      const { liquidations } = await engine.restore({ ...b.plan.state, shadow: null })
      for (const { positionId, symbol, from, to, phrase } of liquidations) b.logger.info({ sessionId: b.sessionId, positionId, symbol, from, to }, phrase)
    } catch (error) {
      undo()
      throw error
    }
    this.current = exchange
    return engine
  }

  watch(since: number, onFunding: (applied: FundingApplied[]) => void): void {
    if (this.reconciler) return
    const { deps, exchange } = this
    const funding = new FundingCollector({ trade: deps.trade, exchange, account: this.account, since, logger: deps.logger })
    this.offFunding = funding.onFunding(onFunding)
    funding.start()
    this.funding = funding
    this.reconciler = new Reconciler({ account: this.account, exchange, trade: deps.trade, clock: deps.clock, onNote: deps.onNote, funding, logger: deps.logger })
    this.reconciler.start()
  }

  async stop(): Promise<void> {
    this.reconciler?.stop()
    this.offFunding?.()
    this.funding?.stop()
    this.current?.detach()
    await this.account.stop()
  }

  private createExchange(b: EngineBuild): BinanceFuturesExchange {
    const { deps } = this
    return new BinanceFuturesExchange({
      account: this.account,
      trade: deps.trade,
      ids: this.ids,
      infos: b.infos,
      clock: deps.clock,
      initialBalance: b.plan.real.saldo,
      openings: deps.openings,
      onNote: deps.onNote,
      takerFeeRate: b.settings.risk.takerFeeRate,
      logger: deps.logger,
      ...(deps.retry ? { retry: deps.retry } : {}),
      ...(this.atStart ? { atStart: this.atStart } : {}),
    })
  }

  // El ATR(14) de 1h al cierre de la última vela; null si Binance no da velas (la adoptada
  // usa entonces el stop de respaldo).
  private async atr1h(symbol: string, now: number): Promise<number | null> {
    const candles = await this.deps.rest.klines(symbol, '1h', { endTime: now, limit: ATR_CANDLES }).catch((error: unknown) => {
      this.deps.logger.warn({ symbol, err: errorMessage(error) }, 'No pude traer las velas de 1h para el stop de la adoptada')
      return []
    })
    const values = atr(candles.filter((c) => c.closed))
    const last = values.at(-1)
    return last !== undefined && Number.isFinite(last) && last > 0 ? last : null
  }
}
