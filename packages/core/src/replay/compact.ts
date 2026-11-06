import { DEFAULT_WARMUP, type ViewTimeframe } from '../market/market-view'
import type { FundingEvent } from '../types'
import { CANDLE_MS } from './clock'
import { type CandleList, PackedCandles, packed } from './packed-candles'
import type { PricedCandles, ReplayData } from './types'

// El mercado de un replay en la forma que menos memoria ocupa, sin cambiar nada de lo que
// el replay ve (mismos trades, eventos y resultado):
//
// - Velas en columnas (`PackedCandles`).
// - Cada moneda desde su calentamiento antes del primer día en que entra al universo: antes
//   de ese día ninguna vista suya se arma, y una vista sólo lee las últimas
//   `DEFAULT_WARMUP` velas cerradas de cada marco. El corte se cuenta en velas, no en
//   tiempo, para que una vista con huecos lea lo mismo que con la serie entera. El final no
//   se corta: una abierta que se mantiene fuera del universo sigue leyendo velas hasta `to`.
// - Sólo las velas de marca de 15m: las de 1h y 4h no las lee nadie (ver `PricedCandles`).
// - El funding sin marca válida ya resuelto con la vela de su instante, como lo resuelve
//   `ReplayMarket` con la serie entera (puede caer antes del corte).

const TIMEFRAMES = ['15m', '1h', '4h'] as const satisfies readonly ViewTimeframe[]

export type PackedSymbolCandles = Record<ViewTimeframe, PricedCandles<PackedCandles>>

export interface CompactSymbol {
  candles: PackedSymbolCandles
  funding: FundingEvent[]
}

// `firstView`: el primer instante en que el replay puede armar una vista de la moneda (el
// comienzo de su primer día en el universo), o null para no cortar.
export function compactSymbol(candles: Record<ViewTimeframe, PricedCandles<CandleList>>, funding: readonly FundingEvent[], firstView: number | null): CompactSymbol {
  const last = { '15m': packed(candles['15m'].last), '1h': packed(candles['1h'].last), '4h': packed(candles['4h'].last) }
  const mark15m = packed(candles['15m'].mark)
  const resolved = funding.map((event) => withCandleMark(event, last['15m'], mark15m))
  const cut = (tf: ViewTimeframe): PackedCandles => (firstView === null ? last[tf] : last[tf].from(warmupStart(last[tf], firstView, DEFAULT_WARMUP[tf])))
  const out = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { last: cut(tf), mark: PackedCandles.EMPTY }])) as PackedSymbolCandles
  const first15m = out['15m'].last.openTime[0]
  out['15m'].mark = first15m === undefined || firstView === null ? mark15m : mark15m.from(mark15m.lastIndexAtOrBefore(first15m - 1) + 1)
  return { candles: out, funding: resolved }
}

// Todo el mercado de un replay compactado (ver `compactSymbol`).
export function compactReplayData(data: ReplayData<CandleList>): ReplayData<PackedCandles> {
  const firstViews = firstViewBySymbol(data.symbolsByDay)
  const candles: Record<string, PackedSymbolCandles> = {}
  const funding: Record<string, FundingEvent[]> = { ...data.funding }
  for (const [symbol, series] of Object.entries(data.candles)) {
    const compact = compactSymbol(series, data.funding[symbol] ?? [], firstViews.get(symbol) ?? null)
    candles[symbol] = compact.candles
    if (data.funding[symbol]) funding[symbol] = compact.funding
  }
  return { ...data, candles, funding }
}

// El comienzo del primer día en que cada moneda está en el universo.
export function firstViewBySymbol(symbolsByDay: Readonly<Record<string, readonly string[]>>): Map<string, number> {
  const first = new Map<string, number>()
  for (const [day, symbols] of Object.entries(symbolsByDay)) {
    const start = Date.parse(day)
    for (const symbol of symbols) first.set(symbol, Math.min(first.get(symbol) ?? start, start))
  }
  return first
}

// Índice desde el que hay que guardar la serie para que toda vista fechada en `t ≥ firstView`
// lea lo mismo que con la serie entera: la `limit`-ésima vela cerrada con `closeTime ≤
// firstView` contando hacia atrás (`CandleSeries.closedUpTo`). Con menos, desde el principio.
function warmupStart(candles: PackedCandles, firstView: number, limit: number): number {
  let count = 0
  for (let i = candles.lastIndexAtOrBefore(firstView); i >= 0; i--) {
    if (candles.closed[i] === 1 && (candles.closeTime[i] as number) <= firstView && ++count === limit) return i
  }
  return 0
}

// Un funding sin marca válida (Binance la deja vacía en registros viejos) se cobra con la
// apertura de la vela de marca de 15m en que cae (o la de último precio si falta): el cobro
// es en el borde de una vela, a veces unos ms después. Sin ninguna vela ahí queda como vino.
export function withCandleMark(event: FundingEvent, last15m: PackedCandles, mark15m: PackedCandles): FundingEvent {
  if (isPrice(event.markPrice)) return event
  const openTime = event.at - (event.at % CANDLE_MS)
  const i = last15m.indexOf(openTime)
  if (i < 0) return event
  const j = mark15m.indexOf(openTime)
  return { ...event, markPrice: (j >= 0 ? mark15m.open[j] : last15m.open[i]) as number }
}

export function isPrice(x: number): boolean {
  return Number.isFinite(x) && x > 0
}
