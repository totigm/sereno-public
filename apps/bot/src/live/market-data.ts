// Lo que el proceso sabe del mercado, compartido entre sesiones (cambiar de sesión no
// vuelve a calentar lo que ya está): series de velas de último precio por símbolo y marco,
// la última marca, los snapshots de futuros y cuándo llegó el último dato de cada uno.

import type { BtcContext, Candle, FuturesSnapshot, MarketView, MarkTick, SymbolInfo, Timeframe } from '@sereno/core'
import { BTC_15M_CANDLES_FOR_BASELINE, buildBtcContext } from '@sereno/core/src/market/btc-context'
import { CandleSeries } from '@sereno/core/src/market/candle-series'
import { buildMarketView, DEFAULT_WARMUP, type ViewTimeframe, type WarmupLimits } from '@sereno/core/src/market/market-view'
import { BTC_SYMBOL, WARMUP_TIMEFRAMES, type WarmedSymbol } from './warmup'

type SymbolSeries = Record<ViewTimeframe, CandleSeries>

const DAY_MS = 86_400_000
const CANDLES_PER_DAY: Record<ViewTimeframe, number> = { '15m': 96, '1h': 24, '4h': 6 }

export class MarketData {
  private readonly series = new Map<string, SymbolSeries>()
  private readonly marks = new Map<string, MarkTick>()
  private readonly futures = new Map<string, FuturesSnapshot[]>()
  private readonly seen = new Map<string, number>()
  // Los que ya tienen su historia: una vela del stream sola no alcanza (el stream de las
  // abiertas se abre antes de calentar).
  private readonly warmed = new Set<string>()
  // Sin datos posibles: el calentamiento falló o Binance rechazó la suscripción.
  readonly failed = new Set<string>()

  constructor(readonly warmupLimits: WarmupLimits = DEFAULT_WARMUP) {}

  isWarm(symbol: string): boolean {
    return this.warmed.has(symbol)
  }

  load(symbol: string, warmed: WarmedSymbol): void {
    const series = this.seriesOf(symbol)
    for (const tf of WARMUP_TIMEFRAMES) for (const candle of warmed[tf].last) series[tf].upsert(candle)
    this.warmed.add(symbol)
    this.failed.delete(symbol)
  }

  addCandle(symbol: string, tf: Timeframe, candle: Candle, at: number): void {
    if (!isViewTimeframe(tf)) return
    this.seriesOf(symbol)[tf].upsert(candle)
    this.seen.set(symbol, Math.max(this.seen.get(symbol) ?? 0, at))
  }

  addMark(tick: MarkTick, at: number): void {
    this.marks.set(tick.symbol, tick)
    this.seen.set(tick.symbol, Math.max(this.seen.get(tick.symbol) ?? 0, at))
  }

  mark(symbol: string): MarkTick | undefined {
    return this.marks.get(symbol)
  }

  lastSeen(symbol: string): number | undefined {
    return this.seen.get(symbol)
  }

  // Deja de seguir estos símbolos (salieron del stream): sus series quedarían viejas y, si
  // vuelven al universo, se calientan de nuevo en vez de decidir sobre una serie con un hueco.
  forget(symbols: readonly string[]): void {
    for (const symbol of symbols) {
      this.series.delete(symbol)
      this.warmed.delete(symbol)
      this.marks.delete(symbol)
      this.futures.delete(symbol)
      this.seen.delete(symbol)
      this.failed.delete(symbol)
    }
  }

  // Recorta cada serie a lo que se le puede pedir: un proceso que corre meses no acumula velas sin tope.
  trim(): void {
    for (const [symbol, series] of this.series) {
      for (const tf of WARMUP_TIMEFRAMES) {
        const keep = this.keep(symbol, tf)
        if (series[tf].size > keep) series[tf] = trimmed(series[tf], keep)
      }
    }
  }

  setFutures(symbol: string, snapshots: FuturesSnapshot[]): void {
    this.futures.set(symbol, snapshots)
  }

  // ¿Llegó la vela de `tf` que cierra en `t`?
  hasClose(symbol: string, tf: ViewTimeframe, t: number, tfMs: number): boolean {
    const last = this.series.get(symbol)?.[tf].closedUpTo(t, 1)[0]
    return last !== undefined && last.openTime >= t - tfMs
  }

  btcContext(t: number): BtcContext {
    const btc = this.seriesOf(BTC_SYMBOL)
    return buildBtcContext({ t, btc4h: btc['4h'], btc15m: btc['15m'], warmup4h: this.warmupLimits['4h'] })
  }

  // La vista de `symbol` fechada en `t`; null sin velas. Sin marca todavía, el último
  // cierre hace de precio (el motor necesita uno para valuar y cerrar).
  view(symbol: string, t: number, info: SymbolInfo, btc: BtcContext): MarketView | null {
    const series = this.series.get(symbol)
    if (!series || series['15m'].size === 0) return null
    const tick = this.marks.get(symbol)
    const close = series['15m'].closedUpTo(t, 1)[0]?.close ?? Number.NaN
    const btcSeries = this.seriesOf(BTC_SYMBOL)
    return buildMarketView({
      t,
      symbol,
      info,
      series,
      futures: this.futures.get(symbol) ?? [],
      btc4h: btcSeries['4h'],
      btc15m: btcSeries['15m'],
      btc,
      markPrice: tick?.markPrice ?? close,
      lastPrice: tick?.lastPrice ?? close,
      warmup: this.warmupLimits,
    })
  }

  // Variación contra el cierre de hace 24 h, como fracción (−0,012 = −1,2 %).
  change24h(symbol: string, now: number): number | null {
    const price = this.marks.get(symbol)?.markPrice
    const ref = this.series.get(symbol)?.['15m'].closedUpTo(now - DAY_MS, 1)[0]?.close
    if (price === undefined || ref === undefined || !(ref > 0)) return null
    return (price - ref) / ref
  }

  // Velas de `tf` cerradas en (from, to]: las que el ciclo guarda en `candles`.
  closedBetween(symbol: string, tf: ViewTimeframe, from: number, to: number): Candle[] {
    return (this.series.get(symbol)?.[tf].closedUpTo(to, 4) ?? []).filter((c) => c.closeTime > from)
  }

  // La ventana de la vista (más la base de volatilidad en BTC 15m) y un día de margen, que
  // es lo más atrás que mira el cambio de 24 h.
  private keep(symbol: string, tf: ViewTimeframe): number {
    const baseline = symbol === BTC_SYMBOL && tf === '15m' ? BTC_15M_CANDLES_FOR_BASELINE : 0
    return this.warmupLimits[tf] + baseline + CANDLES_PER_DAY[tf]
  }

  private seriesOf(symbol: string): SymbolSeries {
    let series = this.series.get(symbol)
    if (!series) {
      series = { '15m': new CandleSeries('15m'), '1h': new CandleSeries('1h'), '4h': new CandleSeries('4h') }
      this.series.set(symbol, series)
    }
    return series
  }
}

// Las últimas `keep` velas cerradas y la que está en curso, si hay una.
function trimmed(series: CandleSeries, keep: number): CandleSeries {
  const out = new CandleSeries(series.tf)
  for (const candle of series.closedUpTo(Number.POSITIVE_INFINITY, keep)) out.upsert(candle)
  const last = series.last()
  if (last && !last.closed) out.upsert(last)
  return out
}

function isViewTimeframe(tf: Timeframe): tf is ViewTimeframe {
  return tf === '15m' || tf === '1h' || tf === '4h'
}
