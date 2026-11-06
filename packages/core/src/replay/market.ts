import { buildBtcContext } from '../market/btc-context'
import { CandleSeries } from '../market/candle-series'
import { buildMarketView, DEFAULT_WARMUP, type ViewTimeframe } from '../market/market-view'
import type { BtcContext, Candle, FundingEvent, FuturesSnapshot, MarketView, SymbolInfo } from '../types'
import type { CandleFeed } from './candle-player'
import { CANDLE_MS, utcDay } from './clock'
import { withCandleMark } from './compact'
import { type CandleList, PackedSeries, packed } from './packed-candles'
import type { ReplayData } from './types'

// El mercado histórico ordenado e indexado para recorrerlo vela a vela: vistas causales
// fechadas en el cierre de cada vela de 15m (spec §5.2), las velas de último precio y de
// marca de cada intervalo y el funding por fecha. Las vistas de un mismo instante se
// arman una sola vez: las comparten todas las corridas que avanzan juntas. Donde falta la
// vela de marca hace de marca la de último precio (lo informa `Coverage`).

const TIMEFRAMES = ['15m', '1h', '4h'] as const satisfies readonly ViewTimeframe[]

interface SymbolMarket {
  info: SymbolInfo
  series: Record<ViewTimeframe, PackedSeries>
  mark15m: PackedSeries
  // Apertura de la última vela de 15m: después de ella la moneda no tiene más datos.
  lastOpenTime: number
  futures: FuturesSnapshot[]
}

export class ReplayMarket {
  readonly infos: Record<string, SymbolInfo>
  private readonly symbols = new Map<string, SymbolMarket>()
  private readonly symbolsByDay: Record<string, string[]>
  private readonly btc4h = new CandleSeries('4h')
  private readonly btc15m = new CandleSeries('15m')
  private readonly funding: FundingEvent[]
  private cachedAt = Number.NaN
  private readonly views = new Map<string, MarketView>()
  private btcContext: BtcContext | null = null

  constructor(data: ReplayData<CandleList>) {
    this.infos = data.infos
    this.symbolsByDay = data.symbolsByDay
    for (const [symbol, candles] of Object.entries(data.candles)) {
      const info = data.infos[symbol]
      if (!info) throw new RangeError(`sin SymbolInfo para ${symbol}`)
      const series = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, new PackedSeries(packed(candles[tf].last))])) as Record<ViewTimeframe, PackedSeries>
      const last15m = series['15m'].candles
      this.symbols.set(symbol, {
        info,
        series,
        mark15m: new PackedSeries(packed(candles['15m'].mark)),
        lastOpenTime: last15m.openTime[last15m.length - 1] ?? Number.NEGATIVE_INFINITY,
        futures: [...(data.futures[symbol] ?? [])].sort((a, b) => a.at - b.at),
      })
    }
    for (const symbols of Object.values(data.symbolsByDay)) {
      for (const symbol of symbols) if (!this.symbols.has(symbol)) throw new RangeError(`el universo incluye ${symbol} y no hay velas suyas`)
    }
    for (const c of chronological(data.btc['4h'])) this.btc4h.upsert(c)
    for (const c of chronological(data.btc['15m'])) this.btc15m.upsert(c)
    this.funding = Object.values(data.funding)
      .flat()
      .map((event) => this.withCandleMark(event))
      .sort((a, b) => a.at - b.at || compare(a.symbol, b.symbol))
  }

  // Universo del día UTC de la vela, sin repetidos y en su orden.
  universe(slot: number): string[] {
    const symbols = this.symbolsByDay[utcDay(slot)]
    if (!symbols) throw new RangeError(`sin universo para el día ${utcDay(slot)}`)
    return [...new Set(symbols)]
  }

  // Vista fechada en `t` (cierre de la vela de 15m previa): velas cerradas con `closeTime ≤ t`
  // y, como precios, la apertura de la vela que empieza en `t`, que es donde se llena una
  // entrada decidida ahí (spec §6: nunca al cierre de la vela que la disparó).
  view(symbol: string, t: number): MarketView {
    this.useInstant(t)
    const cached = this.views.get(symbol)
    if (cached) return cached
    const market = this.require(symbol)
    const feed = this.feed(symbol, t)
    const view = buildMarketView({
      t,
      symbol,
      info: market.info,
      series: market.series,
      futures: market.futures,
      btc4h: this.btc4h,
      btc15m: this.btc15m,
      btc: this.btcAt(t),
      markPrice: feed?.mark.open ?? Number.NaN,
      lastPrice: feed?.last.open ?? Number.NaN,
      warmup: DEFAULT_WARMUP,
    })
    this.views.set(symbol, view)
    return view
  }

  // Velas de último precio y de marca de la vela que abre en `openTime`. Sin la de último
  // precio no hay vela; sin la de marca, la de último precio hace de marca.
  feed(symbol: string, openTime: number): CandleFeed | null {
    const market = this.require(symbol)
    const last = market.series['15m'].get(openTime)
    if (!last) return null
    return { last, mark: market.mark15m.get(openTime) ?? last }
  }

  // ¿La vela de 15m que abre en `openTime` tiene último precio y no marca? Ahí la de
  // último precio hizo de marca: en el precio de la vista y en el recorrido de la vela.
  markFallback(symbol: string, openTime: number): boolean {
    const market = this.require(symbol)
    return market.series['15m'].has(openTime) && !market.mark15m.has(openTime)
  }

  // ¿Llegó la vela de 15m que cierra en `t`? Si no, la decisión de la moneda es "sin vela".
  hasDecisionCandle(symbol: string, t: number): boolean {
    return this.require(symbol).series['15m'].has(t - CANDLE_MS)
  }

  // ¿Tiene la moneda alguna vela desde `t`? Sin ninguna, el contrato se deslistó (spec §9).
  hasDataFrom(symbol: string, t: number): boolean {
    return this.require(symbol).lastOpenTime >= t
  }

  // Eventos de funding con `at` en [from, to), en orden.
  fundingIn(from: number, to: number): FundingEvent[] {
    return this.funding.slice(firstAtOrAfter(this.funding, from), firstAtOrAfter(this.funding, to))
  }

  // Un funding sin marca válida se cobra con la apertura de la vela de marca en que cae
  // (`withCandleMark`). Sin ninguna vela ahí queda como vino y el motor lo informa.
  private withCandleMark(event: FundingEvent): FundingEvent {
    const market = this.symbols.get(event.symbol)
    return market ? withCandleMark(event, market.series['15m'].candles, market.mark15m.candles) : event
  }

  private btcAt(t: number): BtcContext {
    this.useInstant(t)
    this.btcContext ??= buildBtcContext({ t, btc4h: this.btc4h, btc15m: this.btc15m, warmup4h: DEFAULT_WARMUP['4h'] })
    return this.btcContext
  }

  // Las vistas y el contexto de BTC valen para un solo instante.
  private useInstant(t: number): void {
    if (t === this.cachedAt) return
    this.cachedAt = t
    this.views.clear()
    this.btcContext = null
  }

  private require(symbol: string): SymbolMarket {
    const market = this.symbols.get(symbol)
    if (!market) throw new RangeError(`sin velas para ${symbol}`)
    return market
  }
}

function chronological(candles: readonly Candle[]): Candle[] {
  return [...candles].sort((a, b) => a.openTime - b.openTime)
}

function firstAtOrAfter(events: readonly FundingEvent[], t: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((events[mid] as FundingEvent).at < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
