// Descarga del mercado histórico de un replay (spec §9): contratos, universo de cada día,
// velas de último precio y de marca de 15m/1h/4h con su calentamiento, funding y datos de
// futuros de cada moneda que entra algún día, y las velas de BTC para su contexto. Todo
// pasa por el presupuesto del proceso (además del limitador del cliente) y reutiliza las
// velas ya guardadas en `candles`.
//
// Con `compact` (lo que usan el replay y el ajuste semanal) cada moneda queda compactada
// apenas se baja (`compactSymbol`: en columnas, desde su calentamiento antes del primer día
// en el universo y sin las velas de marca de 1h y 4h, que no se bajan): 180 días del
// universo entero como objetos `Candle` no entran en el heap de Node.

import type { Candle, ContractMeta, FundingEvent, FuturesSnapshot, PriceType, SymbolInfo } from '@sereno/core'
import { BTC_15M_CANDLES_FOR_BASELINE } from '@sereno/core/src/market/btc-context'
import { DEFAULT_WARMUP, type ViewTimeframe } from '@sereno/core/src/market/market-view'
import { compactSymbol, firstViewBySymbol } from '@sereno/core/src/replay/compact'
import type { PackedCandles } from '@sereno/core/src/replay/packed-candles'
import type { PricedCandles, ReplayData } from '@sereno/core/src/replay/types'
import type { Repos } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import type { BinanceRest } from '../binance/rest'
import { INTERVAL_MS } from '../binance/types'
import type { CallBudget } from '../jobs/budget'
import { errorMessage, isSymbolScoped, type SymbolFailure } from '../jobs/errors'
import { forEachLimit } from '../jobs/pool'
import { refreshSymbols } from '../jobs/symbols'
import { infosFrom } from '../live/infos'
import { BTC_SYMBOL } from '../live/warmup'
import type { Logger } from '../logger'
import { loadSeries, type CandleSource, type SeriesKey } from './candle-cache'
import { replayFutures } from './futures'
import { dayStarts, type Period } from './period'
import { replayUniverse } from './universe'

export type ReplayRest = Pick<
  BinanceRest,
  'exchangeInfo' | 'fundingInfo' | 'klines' | 'markPriceKlines' | 'fundingRate' | 'openInterestHist' | 'globalLongShortAccountRatio' | 'takerLongShortRatio'
>

export interface DownloadDeps {
  rest: ReplayRest
  repos: Pick<Repos, 'symbols' | 'candles' | 'futures'>
  budget: CallBudget
  logger: Logger
}

export interface DownloadInput {
  period: Period
  // Para saber qué datos de futuros guarda todavía Binance (los últimos 30 días).
  now: number
  settings: Settings
}

// Avance: primero las velas diarias del universo, después las monedas de a una.
export interface DownloadStep {
  stage: 'universe' | 'symbols'
  done: number
  total: number
}

export interface DownloadMeta {
  symbols: string[]
  // Monedas que Binance rechazó (un 400 de ese símbolo): quedan fuera del universo.
  skipped: SymbolFailure[]
  candlesReused: number
  candlesDownloaded: number
  // El primer instante del período con interés abierto o ratios en alguna moneda.
  futuresDataFrom: number | null
}

// Con qué se eligió el universo de cada día: los contratos de hoy y el volumen de cada
// candidata. Con eso el replay guarda sus días en `universe_days` al terminar.
export interface UniverseSelection {
  contracts: ContractMeta[]
  volumesByDay: Record<string, Record<string, number>>
}

const TIMEFRAMES = ['15m', '1h', '4h'] as const satisfies readonly ViewTimeframe[]
const PRICE_TYPES = ['last', 'mark'] as const satisfies readonly PriceType[]
const SERIES_CONCURRENCY = 4

export interface DownloadOptions {
  compact?: boolean
}

export interface ReplayDownload<C> {
  data: ReplayData<C>
  meta: DownloadMeta
  selection: UniverseSelection
}

interface SymbolData {
  candles: Record<ViewTimeframe, PricedCandles>
  funding: FundingEvent[]
  futures: FuturesSnapshot[]
  dataFrom: number | null
}

export function downloadReplayData(deps: DownloadDeps, input: DownloadInput, progress: (step: DownloadStep) => Promise<void>): Promise<ReplayDownload<Candle[]>>
export function downloadReplayData(
  deps: DownloadDeps,
  input: DownloadInput,
  progress: (step: DownloadStep) => Promise<void>,
  options: { compact: true },
): Promise<ReplayDownload<PackedCandles>>
export async function downloadReplayData(
  deps: DownloadDeps,
  { period, now, settings }: DownloadInput,
  progress: (step: DownloadStep) => Promise<void>,
  { compact = false }: DownloadOptions = {},
): Promise<ReplayDownload<Candle[] | PackedCandles>> {
  const { contracts } = await refreshSymbols(deps, settings.risk)
  const allInfos = infosFrom(await deps.repos.symbols.all(), settings.risk)
  const source = countingSource(deps)
  const universe = await replayUniverse(
    (symbol, from, to) => source.load({ symbol, timeframe: '1d', priceType: 'last' }, from, to),
    { contracts, days: dayStarts(period), settings: settings.universe },
    (done, total) => progress({ stage: 'universe', done, total }),
  )
  const symbols = [...new Set(Object.values(universe.symbolsByDay).flat())]
  const firstViews = firstViewBySymbol(universe.symbolsByDay)
  const data: ReplayData<Candle[] | PackedCandles> = { symbolsByDay: universe.symbolsByDay, candles: {}, funding: {}, futures: {}, infos: {}, btc: { '15m': [], '4h': [] } }
  const skipped: SymbolFailure[] = [...universe.skipped]
  let futuresDataFrom: number | null = null
  for (const [i, symbol] of symbols.entries()) {
    const info = allInfos[symbol]
    if (!info) throw new Error(`replay: ${symbol} entró al universo y no está en la tabla de contratos`)
    try {
      const loaded = await loadSymbol(source, info, period, now, compact)
      const kept = compact ? compactSymbol(loaded.candles, loaded.funding, firstViews.get(symbol) ?? null) : loaded
      data.candles[symbol] = kept.candles
      data.funding[symbol] = kept.funding
      data.futures[symbol] = loaded.futures
      data.infos[symbol] = info
      if (loaded.dataFrom !== null) futuresDataFrom = Math.min(futuresDataFrom ?? loaded.dataFrom, loaded.dataFrom)
    } catch (error) {
      if (!isSymbolScoped(error)) throw error
      skipped.push({ symbol, error: errorMessage(error) })
      deps.logger.warn({ symbol, err: errorMessage(error) }, 'Replay: Binance rechazó los datos de la moneda, queda fuera del universo')
    }
    await progress({ stage: 'symbols', done: i + 1, total: symbols.length })
  }
  const loaded = symbols.filter((s) => data.candles[s] !== undefined)
  for (const [day, list] of Object.entries(data.symbolsByDay)) data.symbolsByDay[day] = list.filter((s) => data.candles[s] !== undefined)
  data.btc = await loadBtc(source, period)
  return {
    data,
    meta: { symbols: loaded, skipped, candlesReused: source.reused, candlesDownloaded: source.downloaded, futuresDataFrom },
    selection: { contracts, volumesByDay: universe.volumesByDay },
  }
}

// Las seis series (o, con `onlyMark15m`, sin las de marca de 1h y 4h), el funding y los
// datos de futuros de una moneda.
async function loadSymbol(source: CountingSource, info: SymbolInfo, { from, to }: Period, now: number, onlyMark15m: boolean): Promise<SymbolData> {
  const candles: Record<ViewTimeframe, PricedCandles> = { '15m': { last: [], mark: [] }, '1h': { last: [], mark: [] }, '4h': { last: [], mark: [] } }
  const tasks = TIMEFRAMES.flatMap((timeframe) => PRICE_TYPES.map((priceType) => ({ timeframe, priceType }))).filter(
    ({ timeframe, priceType }) => !onlyMark15m || priceType === 'last' || timeframe === '15m',
  )
  await forEachLimit(tasks, SERIES_CONCURRENCY, async ({ timeframe, priceType }) => {
    const start = Math.max(from - DEFAULT_WARMUP[timeframe] * INTERVAL_MS[timeframe], info.onboardDate)
    candles[timeframe][priceType] = await source.load({ symbol: info.symbol, timeframe, priceType }, start, to)
  })
  const futures = await replayFutures(source, info.symbol, { from, to, now, fundingIntervalHours: info.fundingIntervalHours })
  return { candles, ...futures }
}

// El contexto de mercado sale de BTC aunque no esté en el universo: 4h con su
// calentamiento y 15m con la base de 30 días de la volatilidad además.
async function loadBtc(source: CountingSource, { from, to }: Period): Promise<ReplayData['btc']> {
  const m15 = INTERVAL_MS['15m']
  return {
    '15m': await source.load({ symbol: BTC_SYMBOL, timeframe: '15m', priceType: 'last' }, from - (BTC_15M_CANDLES_FOR_BASELINE + DEFAULT_WARMUP['15m']) * m15, to),
    '4h': await source.load({ symbol: BTC_SYMBOL, timeframe: '4h', priceType: 'last' }, from - DEFAULT_WARMUP['4h'] * INTERVAL_MS['4h'], to),
  }
}

// La fuente de velas y de futuros, contando lo reutilizado y lo bajado para el reporte.
interface CountingSource extends CandleSource {
  rest: ReplayRest
  repos: DownloadDeps['repos']
  reused: number
  downloaded: number
  load(key: SeriesKey, from: number, to: number): Promise<Candle[]>
}

function countingSource(deps: DownloadDeps): CountingSource {
  const source: CountingSource = {
    rest: deps.rest,
    repos: deps.repos,
    budget: deps.budget,
    reused: 0,
    downloaded: 0,
    load: async (key, from, to) => {
      const series = await loadSeries(source, key, from, to)
      source.reused += series.reused
      source.downloaded += series.downloaded
      return series.candles
    },
  }
  return source
}
