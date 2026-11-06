// Fixtures del Binance falso: respuestas estáticas con la forma real de `fapi`, series
// generadas de forma determinista (precio = función del tiempo) y constructores de
// eventos del stream `/market`. Las usan los tests del bot (REST, stream, warmup, replay).

import {
  FUTURES_DATA_HISTORY_MS,
  INTERVAL_MS,
  type KlineEvent,
  type KlineInterval,
  type MarkPriceEvent,
  type RawBookTicker,
  type RawExchangeInfo,
  type RawExchangeSymbol,
  type RawFundingInfo,
  type RawFundingRate,
  type RawKline,
  type RawLongShortRatio,
  type RawOpenInterestHist,
  type RawPremiumIndex,
  type RawTakerLongShortRatio,
  type RawTicker24h,
} from '../types'

export const GEO_BLOCK_MESSAGE = "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error."

const HOUR = 3_600_000

// Precio base por símbolo; los desconocidos valen ~1.
const BASE_PRICE: Record<string, number> = {
  BTCUSDT: 68_000,
  ETHUSDT: 2_500,
  SOLUSDT: 150,
  '1000PEPEUSDT': 0.0095,
  XAUUSDT: 2_650,
  USDCUSDT: 1,
}

export function basePrice(symbol: string): number {
  return BASE_PRICE[symbol.toUpperCase()] ?? 1
}

// Precio determinista: una onda lenta de ±2 % y una rápida de ±0,5 % sobre el base.
export function priceAt(symbol: string, t: number): number {
  const base = basePrice(symbol)
  const slow = Math.sin(t / (6 * HOUR)) * 0.02
  const fast = Math.sin(t / (37 * 60_000)) * 0.005
  return round(base * (1 + slow + fast), 8)
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

function contract(overrides: Partial<RawExchangeSymbol> & Pick<RawExchangeSymbol, 'symbol' | 'baseAsset'>): RawExchangeSymbol {
  return {
    pair: overrides.symbol,
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    onboardDate: 1569398400000,
    quantityPrecision: 3,
    pricePrecision: 2,
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    liquidationFee: '0.012500',
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
      { filterType: 'MAX_NUM_ORDERS', limit: 200 },
      { filterType: 'MAX_NUM_ALGO_ORDERS', limit: 10 },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PERCENT_PRICE', multiplierUp: '1.0500', multiplierDown: '0.9500', multiplierDecimal: '4' },
    ],
    ...overrides,
  }
}

export const EXCHANGE_INFO: RawExchangeInfo = {
  symbols: [
    contract({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      pricePrecision: 1,
      underlyingSubType: ['PoW'],
      filters: [
        { filterType: 'PRICE_FILTER', minPrice: '556.80', maxPrice: '4529764', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
        { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '120', stepSize: '0.001' },
        { filterType: 'MAX_NUM_ORDERS', limit: 200 },
        { filterType: 'MAX_NUM_ALGO_ORDERS', limit: 10 },
        { filterType: 'MIN_NOTIONAL', notional: '50' },
        { filterType: 'PERCENT_PRICE', multiplierUp: '1.0500', multiplierDown: '0.9500', multiplierDecimal: '4' },
      ],
    }),
    contract({ symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 1569398400000, underlyingSubType: ['Layer-1'] }),
    contract({ symbol: 'SOLUSDT', baseAsset: 'SOL', onboardDate: 1600128000000, quantityPrecision: 0, filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.0100', maxPrice: '6000', tickSize: '0.0100' },
      { filterType: 'LOT_SIZE', minQty: '1', maxQty: '1000000', stepSize: '1' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '1', maxQty: '50000', stepSize: '1' },
      { filterType: 'MAX_NUM_ORDERS', limit: 200 },
      { filterType: 'MAX_NUM_ALGO_ORDERS', limit: 10 },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PERCENT_PRICE', multiplierUp: '1.0500', multiplierDown: '0.9500', multiplierDecimal: '4' },
    ] }),
    contract({ symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', onboardDate: 1683446400000, underlyingSubType: ['Meme'], pricePrecision: 7, quantityPrecision: 0 }),
    // TradFi: queda fuera del universo salvo `includeTradFi`.
    contract({ symbol: 'XAUUSDT', baseAsset: 'XAU', onboardDate: 1700000000000, underlyingType: 'COMMODITY', underlyingSubType: ['TradFi'] }),
    // Stablecoin: nunca entra al universo.
    contract({ symbol: 'USDCUSDT', baseAsset: 'USDC', onboardDate: 1700000000000, underlyingSubType: ['Stablecoin'], pricePrecision: 4 }),
    // Contrato trimestral: no es PERPETUAL.
    contract({ symbol: 'BTCUSDT_261226', baseAsset: 'BTC', pair: 'BTCUSDT', contractType: 'CURRENT_QUARTER', underlyingSubType: ['PoW'] }),
    // Listado reciente (2026-10-15): no tiene historia suficiente.
    contract({ symbol: 'NEWUSDT', baseAsset: 'NEW', onboardDate: Date.UTC(2026, 9, 15), underlyingSubType: ['Layer-2'] }),
    // Dado de baja: no está TRADING.
    contract({ symbol: 'OLDUSDT', baseAsset: 'OLD', status: 'SETTLING', underlyingSubType: ['Layer-1'] }),
  ],
}

export const PERPETUAL_SYMBOLS = EXCHANGE_INFO.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING').map((s) => s.symbol)

const QUOTE_VOLUME_24H: Record<string, number> = {
  BTCUSDT: 12_000_000_000,
  ETHUSDT: 6_500_000_000,
  SOLUSDT: 2_100_000_000,
  '1000PEPEUSDT': 900_000_000,
  XAUUSDT: 300_000_000,
  USDCUSDT: 150_000_000,
  NEWUSDT: 50_000_000,
}

export function ticker24h(now: number): RawTicker24h[] {
  return PERPETUAL_SYMBOLS.map((symbol, i) => {
    const last = basePrice(symbol)
    const pct = 1.25 - i * 0.5
    const open = last / (1 + pct / 100)
    const quoteVolume = QUOTE_VOLUME_24H[symbol] ?? 10_000_000
    return {
      symbol,
      priceChange: String(round(last - open, 8)),
      priceChangePercent: pct.toFixed(3),
      weightedAvgPrice: String(last),
      lastPrice: String(last),
      lastQty: '0.5',
      openPrice: String(round(open, 8)),
      highPrice: String(round(last * 1.03, 8)),
      lowPrice: String(round(last * 0.97, 8)),
      volume: String(round(quoteVolume / last, 3)),
      quoteVolume: String(quoteVolume),
      openTime: now - 86_400_000,
      closeTime: now,
      firstId: 1,
      lastId: 1000,
      count: 1000,
    }
  })
}

export const FUNDING_INFO: RawFundingInfo[] = [
  { symbol: 'BTCUSDT', adjustedFundingRateCap: '0.00300000', adjustedFundingRateFloor: '-0.00300000', fundingIntervalHours: 8, disclaimer: false },
  { symbol: 'ETHUSDT', adjustedFundingRateCap: '0.00300000', adjustedFundingRateFloor: '-0.00300000', fundingIntervalHours: 8, disclaimer: false },
  { symbol: 'SOLUSDT', adjustedFundingRateCap: '0.02000000', adjustedFundingRateFloor: '-0.02000000', fundingIntervalHours: 4, disclaimer: false },
  { symbol: '1000PEPEUSDT', adjustedFundingRateCap: '0.02000000', adjustedFundingRateFloor: '-0.02000000', fundingIntervalHours: 1, disclaimer: false },
]

export function fundingIntervalHours(symbol: string): number {
  return FUNDING_INFO.find((f) => f.symbol === symbol)?.fundingIntervalHours ?? 8
}

function nextFundingTime(symbol: string, now: number): number {
  const interval = fundingIntervalHours(symbol) * HOUR
  return Math.floor(now / interval) * interval + interval
}

export function premiumIndex(now: number): RawPremiumIndex[] {
  return PERPETUAL_SYMBOLS.map((symbol) => {
    const index = basePrice(symbol) * 1.0000735
    const mark = symbol === 'BTCUSDT' ? 68_010.5 : round(index * 1.00008, 8)
    return {
      symbol,
      markPrice: String(mark),
      indexPrice: symbol === 'BTCUSDT' ? '68005' : String(round(index, 8)),
      estimatedSettlePrice: String(round(index, 8)),
      lastFundingRate: symbol === 'XAUUSDT' ? '' : '0.00010000',
      interestRate: '0.00010000',
      nextFundingTime: nextFundingTime(symbol, now),
      time: now,
    }
  })
}

export function bookTicker(symbol: string, now: number): RawBookTicker {
  const price = basePrice(symbol)
  const tick = symbol === 'BTCUSDT' ? 0.1 : price * 0.0001
  return {
    symbol,
    bidPrice: String(price),
    bidQty: '1.5',
    askPrice: String(round(price + tick, 8)),
    askQty: '2',
    time: now,
  }
}

export interface KlineRowsQuery {
  symbol: string
  interval: KlineInterval
  startTime?: number | undefined
  endTime?: number | undefined
  limit?: number | undefined
  now: number
  // `markPriceKlines` trae volumen 0.
  mark?: boolean
}

// Reproduce la semántica de `GET /fapi/v1/klines`: velas alineadas al intervalo, de
// `startTime` en adelante (o las últimas `limit` hasta `endTime`/ahora), nunca más de
// `limit`, incluida la vela en curso si `now` cae dentro de ella.
export function klineRows({ symbol, interval, startTime, endTime, limit = 500, now, mark = false }: KlineRowsQuery): RawKline[] {
  const ms = INTERVAL_MS[interval]
  const count = Math.max(1, Math.min(limit, 1500))
  const lastAllowed = Math.floor(Math.min(now, endTime ?? now) / ms) * ms
  let first: number
  if (startTime !== undefined) first = Math.ceil(startTime / ms) * ms
  else first = lastAllowed - (count - 1) * ms
  const rows: RawKline[] = []
  for (let open = first; open <= lastAllowed && rows.length < count; open += ms) {
    const o = priceAt(symbol, open)
    const c = priceAt(symbol, Math.min(open + ms, now))
    const h = round(Math.max(o, c) * 1.001, 8)
    const l = round(Math.min(o, c) * 0.999, 8)
    const volume = mark ? 0 : round(1000 + (open / ms) % 97, 3)
    const quote = mark ? 0 : round(volume * (o + c) / 2, 8)
    rows.push([open, String(o), String(h), String(l), String(c), String(volume), open + ms - 1, String(quote), mark ? 0 : 1500, mark ? '0' : String(round(volume / 2, 3)), mark ? '0' : String(round(quote / 2, 8)), '0'])
  }
  return rows
}

export interface FundingRateQueryFixture {
  symbol: string
  startTime?: number | undefined
  endTime?: number | undefined
  limit?: number | undefined
  now: number
}

export function fundingRateRows({ symbol, startTime, endTime, limit = 100, now }: FundingRateQueryFixture): RawFundingRate[] {
  const interval = fundingIntervalHours(symbol) * HOUR
  const count = Math.max(1, Math.min(limit, 1000))
  const last = Math.floor(Math.min(now, endTime ?? now) / interval) * interval
  const first = startTime !== undefined ? Math.ceil(startTime / interval) * interval : last - (count - 1) * interval
  const rows: RawFundingRate[] = []
  for (let t = first; t <= last && rows.length < count; t += interval) {
    const rate = round(0.0001 + Math.sin(t / (3 * 86_400_000)) * 0.0002, 8)
    rows.push({ symbol, fundingTime: t, fundingRate: rate.toFixed(8), markPrice: String(priceAt(symbol, t)) })
  }
  return rows
}

export interface DataRangeFixture {
  startTime?: number | undefined
  endTime?: number | undefined
}

// Semántica de `/futures/data/*` con período 1h: desde `startTime` en adelante (o los últimos
// `limit` hasta `endTime`/ahora), nunca más de `limit` ni más viejos que 30 días.
function hourlyTimestamps(limit: number, now: number, { startTime, endTime }: DataRangeFixture = {}): number[] {
  const count = Math.max(1, Math.min(limit, 500))
  const oldest = Math.ceil((now - FUTURES_DATA_HISTORY_MS) / HOUR) * HOUR
  const last = Math.floor(Math.min(now, endTime ?? now) / HOUR) * HOUR
  const first = Math.max(oldest, startTime !== undefined ? Math.ceil(startTime / HOUR) * HOUR : last - (count - 1) * HOUR)
  const out: number[] = []
  for (let t = first; t <= last && out.length < count; t += HOUR) out.push(t)
  return out
}

export function openInterestRows(symbol: string, limit: number, now: number, range?: DataRangeFixture): RawOpenInterestHist[] {
  return hourlyTimestamps(limit, now, range).map((timestamp) => {
    const oi = round(80_000 * (1 + Math.sin(timestamp / (12 * HOUR)) * 0.1), 3)
    return { symbol, sumOpenInterest: String(oi), sumOpenInterestValue: String(round(oi * priceAt(symbol, timestamp), 8)), timestamp }
  })
}

export function longShortRows(symbol: string, limit: number, now: number, range?: DataRangeFixture): RawLongShortRatio[] {
  return hourlyTimestamps(limit, now, range).map((timestamp) => {
    const long = round(0.5 + Math.sin(timestamp / (9 * HOUR)) * 0.1, 4)
    const short = round(1 - long, 4)
    return { symbol, longShortRatio: round(long / short, 4).toFixed(4), longAccount: long.toFixed(4), shortAccount: short.toFixed(4), timestamp }
  })
}

export function takerRows(limit: number, now: number, range?: DataRangeFixture): RawTakerLongShortRatio[] {
  return hourlyTimestamps(limit, now, range).map((timestamp) => {
    const buy = round(5_000 * (1 + Math.sin(timestamp / (5 * HOUR)) * 0.2), 3)
    const sell = round(5_000 * (1 - Math.sin(timestamp / (5 * HOUR)) * 0.2), 3)
    return { buySellRatio: round(buy / sell, 4).toFixed(4), buyVol: buy.toFixed(3), sellVol: sell.toFixed(3), timestamp }
  })
}

// ---------- Eventos del stream /market ----------

export interface KlineEventInput {
  symbol: string
  interval: KlineInterval
  openTime: number
  closed: boolean
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  quoteVolume?: number
  eventTime?: number
}

export function klineEvent({ symbol, interval, openTime, closed, open = 68_000, high = 68_250, low = 67_900, close = 68_200, volume = 120.5, quoteVolume = 8_200_000, eventTime }: KlineEventInput): KlineEvent {
  const ms = INTERVAL_MS[interval]
  const upper = symbol.toUpperCase()
  return {
    e: 'kline',
    E: eventTime ?? openTime + (closed ? ms : 1_000),
    s: upper,
    k: {
      t: openTime,
      T: openTime + ms - 1,
      s: upper,
      i: interval,
      f: 100,
      L: 200,
      o: String(open),
      c: String(close),
      h: String(high),
      l: String(low),
      v: String(volume),
      n: 100,
      x: closed,
      q: String(quoteVolume),
      V: String(volume / 2),
      Q: String(quoteVolume / 2),
      B: '0',
    },
  }
}

export interface MarkPriceEventInput {
  symbol: string
  markPrice: number
  indexPrice?: number
  fundingRate: string
  nextFundingTime: number
  at: number
}

export function markPriceEvent({ symbol, markPrice, indexPrice = markPrice, fundingRate, nextFundingTime, at }: MarkPriceEventInput): MarkPriceEvent {
  return {
    e: 'markPriceUpdate',
    E: at,
    s: symbol.toUpperCase(),
    p: String(markPrice),
    i: String(indexPrice),
    P: String(indexPrice),
    r: fundingRate,
    T: nextFundingTime,
    ap: String(markPrice),
  }
}

export function streamNameOf(symbol: string, stream: string): string {
  return `${symbol.toLowerCase()}@${stream}`
}
