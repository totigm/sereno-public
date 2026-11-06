// Tipos del cable de Binance USDT-M (REST `fapi` y stream `/market`) y las formas
// parseadas que exponen `BinanceRest` y `MarketStream`. Los números llegan como
// string en Binance; acá se tipan tal cual llegan y se convierten en el cliente.

import type { Timeframe } from '@sereno/core'

export type KlineInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d' | '3d' | '1w'

export const INTERVAL_MS: Record<KlineInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
}

export const TIMEFRAMES: readonly Timeframe[] = ['15m', '1h', '4h', '1d']

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Períodos de `/futures/data/*` (open interest y ratios).
export type DataPeriod = '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d'

// ---------- REST: respuestas crudas ----------

// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
export type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string]

export interface RawExchangeInfo {
  symbols: RawExchangeSymbol[]
}

export interface RawExchangeSymbol {
  symbol: string
  pair: string
  contractType: string
  status: string
  baseAsset: string
  quoteAsset: string
  onboardDate: number
  quantityPrecision: number
  pricePrecision: number
  underlyingType: string
  // Algunos contratos no lo traen.
  underlyingSubType?: string[]
  liquidationFee: string
  filters: RawSymbolFilter[]
}

export type RawSymbolFilter =
  | { filterType: 'PRICE_FILTER'; minPrice: string; maxPrice: string; tickSize: string }
  | { filterType: 'LOT_SIZE'; minQty: string; maxQty: string; stepSize: string }
  | { filterType: 'MARKET_LOT_SIZE'; minQty: string; maxQty: string; stepSize: string }
  | { filterType: 'MIN_NOTIONAL'; notional: string }
  | { filterType: 'MAX_NUM_ORDERS'; limit: number }
  | { filterType: 'MAX_NUM_ALGO_ORDERS'; limit: number }
  | { filterType: 'PERCENT_PRICE'; multiplierUp: string; multiplierDown: string; multiplierDecimal: string }

export interface RawTicker24h {
  symbol: string
  priceChange: string
  priceChangePercent: string
  weightedAvgPrice: string
  lastPrice: string
  lastQty: string
  openPrice: string
  highPrice: string
  lowPrice: string
  volume: string
  quoteVolume: string
  openTime: number
  closeTime: number
  firstId: number
  lastId: number
  count: number
}

export interface RawPremiumIndex {
  symbol: string
  markPrice: string
  indexPrice: string
  estimatedSettlePrice: string
  lastFundingRate: string
  interestRate: string
  nextFundingTime: number
  time: number
}

export interface RawBookTicker {
  symbol: string
  bidPrice: string
  bidQty: string
  askPrice: string
  askQty: string
  time: number
}

export interface RawFundingRate {
  symbol: string
  fundingTime: number
  fundingRate: string
  markPrice: string
}

export interface RawFundingInfo {
  symbol: string
  adjustedFundingRateCap: string
  adjustedFundingRateFloor: string
  fundingIntervalHours: number
  disclaimer?: boolean
}

export interface RawOpenInterestHist {
  symbol: string
  sumOpenInterest: string
  sumOpenInterestValue: string
  timestamp: number
}

export interface RawLongShortRatio {
  symbol: string
  longShortRatio: string
  longAccount: string
  shortAccount: string
  timestamp: number
}

export interface RawTakerLongShortRatio {
  buySellRatio: string
  buyVol: string
  sellVol: string
  timestamp: number
}

export interface RawBinanceError {
  code: number
  msg: string
}

export interface RawServerTime {
  serverTime: number
}

// `GET /fapi/v1/leverageBracket` (USER_DATA). En este endpoint los números llegan como números.
export interface RawLeverageBracket {
  symbol: string
  // Sólo si Binance ajustó los brackets de la cuenta para ese símbolo.
  notionalCoef?: number
  brackets: RawBracketTier[]
}

export interface RawBracketTier {
  bracket: number
  initialLeverage: number
  notionalCap: number
  notionalFloor: number
  maintMarginRatio: number
  cum: number
}

// `GET /fapi/v1/commissionRate` (USER_DATA).
export interface RawCommissionRate {
  symbol: string
  makerCommissionRate: string
  takerCommissionRate: string
}

// ---------- REST: respuestas parseadas ----------

export interface Ticker24h {
  symbol: string
  lastPrice: number
  quoteVolume: number
  priceChangePercent: number
}

export interface PremiumIndex {
  symbol: string
  markPrice: number
  indexPrice: number
  lastFundingRate: number | null
  nextFundingTime: number | null
  time: number
}

export interface BookTicker {
  symbol: string
  bidPrice: number
  bidQty: number
  askPrice: number
  askQty: number
  time: number
}

export interface FundingInfo {
  symbol: string
  fundingIntervalHours: number
  adjustedFundingRateCap: number
  adjustedFundingRateFloor: number
}

export interface OpenInterestPoint {
  symbol: string
  sumOpenInterest: number
  sumOpenInterestValue: number
  timestamp: number
}

export interface LongShortRatioPoint {
  symbol: string
  longShortRatio: number
  longAccount: number
  shortAccount: number
  timestamp: number
}

export interface TakerRatioPoint {
  buySellRatio: number
  buyVol: number
  sellVol: number
  timestamp: number
}

// Las comisiones de la cuenta (taker y maker), como fracción del nocional.
export interface CommissionRate {
  symbol: string
  takerFeeRate: number
  makerFeeRate: number
}

export interface KlineQuery {
  startTime?: number
  endTime?: number
  limit?: number
}

export interface FundingRateQuery {
  startTime?: number
  endTime?: number
  limit?: number
}

// Rango de `/futures/data/*` sobre `timestamp`.
export interface DataRange {
  startTime?: number
  endTime?: number
}

// Lo que guarda Binance de `/futures/data/*`: los últimos 30 días.
export const FUTURES_DATA_HISTORY_MS = 30 * INTERVAL_MS['1d']

// ---------- Stream /market ----------

export type MarketStreamName = `kline_${Timeframe}` | 'markPrice@1s' | 'markPrice'

export interface CombinedStreamMessage<T = unknown> {
  stream: string
  data: T
}

export interface KlineEvent {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number // openTime
    T: number // closeTime
    s: string
    i: string // intervalo
    f: number
    L: number
    o: string
    c: string
    h: string
    l: string
    v: string // volumen base
    n: number
    x: boolean // vela cerrada
    q: string // volumen en quote
    V: string
    Q: string
    B: string
  }
}

export interface MarkPriceEvent {
  e: 'markPriceUpdate'
  E: number
  s: string
  p: string // precio de marca
  i: string // precio índice
  P: string // precio estimado de liquidación del funding
  r: string // funding actual (vacío si el contrato no tiene)
  T: number // próximo funding
  ap?: string // media móvil del precio de marca (campo nuevo)
}

export interface StreamControlMessage {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE'
  params: string[]
  id: number
}
