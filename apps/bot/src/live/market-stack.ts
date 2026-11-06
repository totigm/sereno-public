// Los datos de mercado del proceso (spec §12): el stream, las series de velas, el funding y el
// spread observado. Cambiar de sesión no los reinicia, y en mainnet los comparten la sesión en
// papel y la real (son los mismos precios). Cada sesión pide sus monedas por su cuenta
// (`feed(id)`): el stream lleva la unión, así lo que suelta una nunca le saca a la otra lo que
// sigue pidiendo. BTC siempre queda: es el contexto de mercado.
//
// Con `persistCandles` las velas que se recuperan después de un corte se guardan en `candles`;
// sin él (testnet: sus precios no son los de la base) sólo viven en memoria.

import type { FundingEvent, MarkTick } from '@sereno/core'
import type { CandlesRepo } from '@sereno/db'
import { MAX_KLINES_LIMIT } from '../binance/rest'
import { INTERVAL_MS } from '../binance/types'
import type { Gap, MarketStream } from '../binance/ws'
import { errorMessage } from '../jobs/errors'
import type { Logger } from '../logger'
import { CandleGate } from './cycle'
import { FundingTracker } from './funding'
import type { LiveRest, MarketFeed } from './live-types'
import { MarketData } from './market-data'
import { SpreadSampler } from './spreads'
import type { Clock } from './timers'
import { BTC_SYMBOL } from './warmup'

export type LiveStream = Pick<MarketStream, 'on' | 'start' | 'stop' | 'subscribe' | 'unsubscribe' | 'symbols'>

export interface MarketStackDeps {
  rest: LiveRest
  // El stream necesita sus símbolos al crearse: se abre con lo que pide la primera sesión.
  streamFactory: (symbols: string[]) => LiveStream
  clock: Clock
  logger: Logger
  repos: { candles: Pick<CandlesRepo, 'upsertMany'> }
  persistCandles: boolean
}

type MarkListener = (tick: MarkTick, funding: FundingEvent | null) => void
type ErrorListener = (message: string) => void

export class MarketStack {
  readonly market = new MarketData()
  readonly gate: CandleGate
  readonly funding = new FundingTracker()
  readonly spreads = new SpreadSampler()
  private readonly wanted = new Map<string, Set<string>>()
  private readonly markListeners = new Set<MarkListener>()
  private readonly reconnectListeners = new Set<() => void>()
  private readonly errorListeners = new Set<ErrorListener>()
  private stream: LiveStream | null = null

  constructor(private readonly deps: MarketStackDeps) {
    this.gate = new CandleGate(this.market, deps.clock)
  }

  get rest(): LiveRest {
    return this.deps.rest
  }

  // Lo que pide una sesión. `keepOnly` reemplaza su pedido; del stream sale sólo lo que ya no
  // pide nadie.
  feed(consumerId: string): MarketFeed {
    return {
      want: (symbols) => this.want(consumerId, symbols),
      keepOnly: (symbols) => this.keepOnly(consumerId, symbols),
    }
  }

  onMark(cb: MarkListener): () => void {
    return subscribe(this.markListeners, cb)
  }

  // El stream se cortó: cada sesión decide qué hace con el primer precio al volver.
  onReconnecting(cb: () => void): () => void {
    return subscribe(this.reconnectListeners, cb)
  }

  // Lo que falla en el stream o al recuperar velas: va a los errores recientes de cada sesión.
  onError(cb: ErrorListener): () => void {
    return subscribe(this.errorListeners, cb)
  }

  stop(): void {
    this.stream?.stop()
  }

  private want(consumerId: string, symbols: readonly string[]): void {
    const own = this.wanted.get(consumerId) ?? new Set<string>()
    for (const symbol of symbols) own.add(symbol)
    own.add(BTC_SYMBOL)
    this.wanted.set(consumerId, own)
    if (!this.stream) {
      this.stream = this.openStream([...this.union()])
      return
    }
    const current = new Set(this.stream.symbols)
    const added = [...own].filter((s) => !current.has(s))
    if (added.length > 0) this.stream.subscribe(added)
  }

  private keepOnly(consumerId: string, symbols: readonly string[]): void {
    this.wanted.set(consumerId, new Set([...symbols, BTC_SYMBOL]))
    if (!this.stream) return
    const keep = this.union()
    const extra = this.stream.symbols.filter((s) => !keep.has(s))
    if (extra.length === 0) return
    this.stream.unsubscribe(extra)
    this.market.forget(extra)
  }

  private union(): Set<string> {
    const all = new Set<string>([BTC_SYMBOL])
    for (const own of this.wanted.values()) for (const symbol of own) all.add(symbol)
    return all
  }

  private openStream(symbols: string[]): LiveStream {
    const { clock, logger } = this.deps
    const stream = this.deps.streamFactory(symbols)
    stream.on('kline', (symbol, tf, candle) => {
      this.market.addCandle(symbol, tf, candle, clock.now())
      this.gate.notify()
    })
    stream.on('mark', (tick) => {
      this.market.addMark(tick, clock.now())
      const funding = this.funding.note(tick)
      for (const cb of this.markListeners) cb(tick, funding)
    })
    stream.on('gap', (gap) => void this.backfill(gap))
    stream.on('status', (status) => {
      logger.info({ status }, 'Stream de mercado')
      if (status === 'reconnecting') for (const cb of this.reconnectListeners) cb()
    })
    stream.on('subscription_failed', (failed) => {
      for (const symbol of failed) this.market.failed.add(symbol)
      this.report(`Binance rechazó la suscripción de ${failed.join(', ')}: quedan degradadas`)
    })
    stream.start()
    return stream
  }

  // Velas perdidas en un corte: se piden por REST antes de decidir (el ciclo espera).
  private async backfill({ symbol, tf, from, to }: Gap): Promise<void> {
    const { rest, repos, clock, logger, persistCandles } = this.deps
    const ms = INTERVAL_MS[tf]
    this.gate.beginBackfill(symbol)
    try {
      for (let start = from; start <= to; start += MAX_KLINES_LIMIT * ms) {
        const end = Math.min(to, start + (MAX_KLINES_LIMIT - 1) * ms)
        const candles = (await rest.klines(symbol, tf, { startTime: start, endTime: end + ms - 1, limit: MAX_KLINES_LIMIT })).filter((c) => c.closed)
        for (const candle of candles) this.market.addCandle(symbol, tf, candle, clock.now())
        if (persistCandles && candles.length > 0) await repos.candles.upsertMany({ symbol, timeframe: tf, priceType: 'last' }, candles)
      }
      logger.info({ symbol, tf, from, to }, 'Velas perdidas recuperadas')
    } catch (error) {
      const message = `No pude recuperar las velas perdidas de ${symbol}`
      logger.error({ err: errorMessage(error) }, message)
      this.report(`${message}: ${errorMessage(error)}`)
    } finally {
      this.gate.endBackfill(symbol)
    }
  }

  private report(message: string): void {
    for (const cb of this.errorListeners) cb(message)
  }
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}
