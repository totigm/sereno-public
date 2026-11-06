import type { Candle } from '@sereno/core'
import { describe, expect, it, vi } from 'vitest'
import type { MarketStreamEvents } from '../../src/binance/ws'
import { silentLogger } from '../../src/logger'
import type { LiveRest } from '../../src/live/live-types'
import { MarketStack } from '../../src/live/market-stack'
import type { LiveStream } from '../../src/live/runtime'
import { ManualClock, settle } from '../helpers/manual-clock'

const T = Date.UTC(2026, 10, 1, 12)
const M15 = 15 * 60_000

// Un stream en memoria: guarda sus símbolos y deja disparar sus eventos.
class StubStream implements LiveStream {
  readonly handlers = new Map<keyof MarketStreamEvents, ((...args: never[]) => void)[]>()

  constructor(public symbols: string[]) {}

  on<K extends keyof MarketStreamEvents>(event: K, handler: MarketStreamEvents[K]): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as unknown as (...args: never[]) => void])
    return () => undefined
  }

  emit<K extends keyof MarketStreamEvents>(event: K, ...args: Parameters<MarketStreamEvents[K]>): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as unknown as (...a: Parameters<MarketStreamEvents[K]>) => void)(...args)
  }

  start(): void {}
  stop(): void {}

  subscribe(symbols: string[]): void {
    this.symbols = [...new Set([...this.symbols, ...symbols])]
  }

  unsubscribe(symbols: string[]): void {
    this.symbols = this.symbols.filter((s) => !symbols.includes(s))
  }
}

function candleAt(openTime: number): Candle {
  return { openTime, closeTime: openTime + M15 - 1, open: 1, high: 1, low: 1, close: 1, volume: 1, quoteVolume: 1, closed: true }
}

function stackWith(persistCandles: boolean) {
  const streams: StubStream[] = []
  const upsertMany = vi.fn(async () => undefined)
  const klines = vi.fn(async () => [candleAt(T - M15)])
  const stack = new MarketStack({
    rest: { klines } as unknown as LiveRest,
    streamFactory: (symbols) => {
      const stream = new StubStream(symbols)
      streams.push(stream)
      return stream
    },
    clock: new ManualClock(T),
    logger: silentLogger,
    repos: { candles: { upsertMany } },
    persistCandles,
  })
  return { stack, streams, upsertMany, klines }
}

describe('MarketStack', () => {
  it('keepOnly de la real no saca las monedas de la de papel', () => {
    const { stack, streams } = stackWith(true)
    const paper = stack.feed('paper')
    const real = stack.feed('real')
    paper.want(['ETHUSDT', 'SOLUSDT'])
    real.want(['XRPUSDT', 'ETHUSDT'])
    expect(streams).toHaveLength(1)
    expect([...streams[0]!.symbols].sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])

    real.keepOnly(['ETHUSDT'])
    expect([...streams[0]!.symbols].sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    paper.keepOnly(['SOLUSDT'])
    // ETH la sigue pidiendo la real.
    expect([...streams[0]!.symbols].sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    real.keepOnly([])
    expect([...streams[0]!.symbols].sort()).toEqual(['BTCUSDT', 'SOLUSDT'])
  })

  it('sin persistCandles no escribe velas', async () => {
    for (const persist of [true, false]) {
      const { stack, streams, upsertMany, klines } = stackWith(persist)
      stack.feed('real').want(['ETHUSDT'])
      streams[0]!.emit('gap', { symbol: 'ETHUSDT', tf: '15m', from: T - M15, to: T - M15 })
      await vi.waitFor(() => expect(klines).toHaveBeenCalled())
      await settle()
      expect(upsertMany).toHaveBeenCalledTimes(persist ? 1 : 0)
    }
  })

  it('reparte cada precio con su funding a quienes escuchan y avisa los cortes', () => {
    const { stack, streams } = stackWith(true)
    stack.feed('paper').want(['ETHUSDT'])
    const marks: string[] = []
    const cuts: string[] = []
    stack.onMark((tick) => marks.push(`papel:${tick.symbol}`))
    stack.onMark((tick) => marks.push(`real:${tick.symbol}`))
    stack.onReconnecting(() => cuts.push('corte'))
    streams[0]!.emit('mark', { symbol: 'ETHUSDT', markPrice: 2_000, lastPrice: 2_000, at: T, fundingRate: 0.0001, nextFundingTime: T + 3_600_000 })
    streams[0]!.emit('status', 'reconnecting')
    expect(marks).toEqual(['papel:ETHUSDT', 'real:ETHUSDT'])
    expect(cuts).toEqual(['corte'])
    expect(stack.market.mark('ETHUSDT')?.markPrice).toBe(2_000)
  })
})
