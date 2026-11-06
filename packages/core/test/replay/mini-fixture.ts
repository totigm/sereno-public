import type { ViewTimeframe } from '../../src/market/market-view'
import type { ReplayData } from '../../src/replay/types'
import type { Candle, FundingEvent, FuturesSnapshot, SymbolInfo } from '../../src/types'
import raw from '../fixtures/replay-mini.json'

// Carga `replay-mini.json` (2 símbolos, 5 días, ver `_note`) como `ReplayData`. El JSON
// sale de `gen-replay-mini.ts`, al lado del fixture.

type Row = number[]
interface Series {
  start: number
  span: number
  last: Row[]
  mark?: Row[]
}
interface MiniFixture {
  from: number
  to: number
  symbolsByDay: Record<string, string[]>
  infos: Record<string, SymbolInfo>
  series: Record<string, Record<ViewTimeframe, Series>>
  funding: Record<string, Row[]>
  futures: Record<string, (number | null)[][]>
}

const fixture = raw as unknown as MiniFixture

export const MINI_FROM = fixture.from
export const MINI_TO = fixture.to

function candles(series: Series, rows: Row[]): Candle[] {
  return rows.map(([open = 0, high = 0, low = 0, close = 0, volume = 0], i) => {
    const openTime = series.start + i * series.span
    return { openTime, closeTime: openTime + series.span - 1, open, high, low, close, volume, quoteVolume: volume * close, closed: true }
  })
}

function futuresOf(rows: (number | null)[][]): FuturesSnapshot[] {
  return rows.map(([at, fundingRate, nextFundingTime, openInterest, openInterest1hAgo, openInterest4hAgo, longShortRatio, takerRatio]) => ({
    at: at ?? 0,
    fundingRate: fundingRate ?? null,
    nextFundingTime: nextFundingTime ?? null,
    openInterest: openInterest ?? null,
    openInterest1hAgo: openInterest1hAgo ?? null,
    openInterest4hAgo: openInterest4hAgo ?? null,
    longShortRatio: longShortRatio ?? null,
    takerRatio: takerRatio ?? null,
  }))
}

export function miniData(): ReplayData {
  const symbols = Object.keys(fixture.series)
  const candlesBySymbol = Object.fromEntries(
    symbols.map((symbol) => {
      const s = fixture.series[symbol]!
      const m15 = s['15m']
      return [
        symbol,
        {
          '15m': { last: candles(m15, m15.last), mark: candles(m15, m15.mark ?? []) },
          '1h': { last: candles(s['1h'], s['1h'].last), mark: [] },
          '4h': { last: candles(s['4h'], s['4h'].last), mark: [] },
        },
      ]
    }),
  )
  const funding: Record<string, FundingEvent[]> = Object.fromEntries(
    symbols.map((symbol) => [symbol, (fixture.funding[symbol] ?? []).map(([at = 0, rate = 0, markPrice = 0]) => ({ symbol, at, rate, markPrice }))]),
  )
  const btc = candlesBySymbol['BTCUSDT']!
  return {
    symbolsByDay: structuredClone(fixture.symbolsByDay),
    candles: candlesBySymbol,
    funding,
    futures: Object.fromEntries(symbols.map((symbol) => [symbol, futuresOf(fixture.futures[symbol] ?? [])])),
    infos: structuredClone(fixture.infos),
    btc: { '15m': btc['15m'].last, '4h': btc['4h'].last },
  }
}

// El fixture con el primer funding de BTC (el de `MINI_FROM`) con una tasa inválida: el
// motor lo saltea y lo avisa por `onFailure` en cada corrida que pasa por ahí.
export const BAD_FUNDING_AT = MINI_FROM

export function miniDataWithBadFunding(): ReplayData {
  const data = miniData()
  const [first, ...rest] = data.funding['BTCUSDT'] ?? []
  if (first?.at !== BAD_FUNDING_AT) throw new Error('el fixture no tiene funding de BTC al inicio')
  return { ...data, funding: { ...data.funding, BTCUSDT: [{ ...first, rate: Number.NaN }, ...rest] } }
}
