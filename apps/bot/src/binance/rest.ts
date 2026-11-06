// Cliente REST de Binance USDT-M (`fapi`) para datos de mercado. El transporte (limitador,
// header de peso, reintentos con backoff en 429/418/5xx/red, errores tipados, firma) es
// `BinanceHttp`. Pesos verificados en la spec §3. Con clave, firma los pocos pedidos
// `USER_DATA` de lectura (mmr y comisiones de la cuenta). Las órdenes y `/sapi` viven en
// `BinanceTradeRest`, con su propia clave.

import type { Candle, ContractMeta, FundingEvent } from '@sereno/core'
import type { Logger } from 'pino'
import { silentLogger } from '../logger'
import { toCommissionRate } from './account'
import { BinanceHttp, type BinanceHttpOptions, type Cost, type Params } from './http'
import { num } from './numbers'
import {
  INTERVAL_MS,
  type BookTicker,
  type CommissionRate,
  type DataPeriod,
  type DataRange,
  type FundingInfo,
  type FundingRateQuery,
  type KlineInterval,
  type KlineQuery,
  type LongShortRatioPoint,
  type OpenInterestPoint,
  type PremiumIndex,
  type RawBookTicker,
  type RawCommissionRate,
  type RawExchangeInfo,
  type RawExchangeSymbol,
  type RawFundingInfo,
  type RawFundingRate,
  type RawKline,
  type RawLeverageBracket,
  type RawLongShortRatio,
  type RawOpenInterestHist,
  type RawPremiumIndex,
  type RawTakerLongShortRatio,
  type RawTicker24h,
  type TakerRatioPoint,
  type Ticker24h,
} from './types'

export type BinanceRestOptions = BinanceHttpOptions

export const MAX_KLINES_LIMIT = 1500

// Peso de `klines`/`markPriceKlines` según `limit` (tabla de Binance).
export function klinesWeight(limit: number): number {
  if (limit < 100) return 1
  if (limit < 500) return 2
  if (limit <= 1000) return 5
  return 10
}

export class BinanceRest {
  private readonly http: BinanceHttp
  private readonly now: () => number
  private readonly logger: Logger

  constructor(opts: BinanceRestOptions) {
    this.http = new BinanceHttp(opts)
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? silentLogger
  }

  // Gate de despliegue: 200 desde esta IP o Binance no nos deja operar.
  async ping(): Promise<void> {
    await this.request<Record<string, never>>('/fapi/v1/ping', {}, { kind: 'weight', weight: 1 })
  }

  async exchangeInfo(): Promise<ContractMeta[]> {
    const raw = await this.request<RawExchangeInfo>('/fapi/v1/exchangeInfo', {}, { kind: 'weight', weight: 1 })
    // Un contrato raro (campo vacío, filtro nuevo) no puede dejar sin universo a los demás.
    const contracts: ContractMeta[] = []
    for (const symbol of raw.symbols) {
      try {
        contracts.push(toContractMeta(symbol))
      } catch (err) {
        this.logger.warn({ symbol: symbol.symbol, err: errorMessage(err) }, 'Binance: contrato con datos inválidos en exchangeInfo, se omite')
      }
    }
    return contracts
  }

  klines(symbol: string, interval: KlineInterval, query: KlineQuery = {}): Promise<Candle[]> {
    return this.fetchKlines('/fapi/v1/klines', symbol, interval, query)
  }

  markPriceKlines(symbol: string, interval: KlineInterval, query: KlineQuery = {}): Promise<Candle[]> {
    return this.fetchKlines('/fapi/v1/markPriceKlines', symbol, interval, query)
  }

  // Velas diarias para el universo del replay; `endTime` es inclusivo sobre `openTime`.
  dailyKlines(symbol: string, startTime: number, endTime: number): Promise<Candle[]> {
    return this.klines(symbol, '1d', { startTime, endTime, limit: MAX_KLINES_LIMIT })
  }

  async ticker24h(): Promise<Ticker24h[]> {
    const raw = await this.request<RawTicker24h[]>('/fapi/v1/ticker/24hr', {}, { kind: 'weight', weight: 40 })
    return raw.map((t) => ({ symbol: t.symbol, lastPrice: num(t.lastPrice), quoteVolume: num(t.quoteVolume), priceChangePercent: num(t.priceChangePercent) }))
  }

  premiumIndex(symbol: string): Promise<PremiumIndex>
  premiumIndex(): Promise<PremiumIndex[]>
  async premiumIndex(symbol?: string): Promise<PremiumIndex | PremiumIndex[]> {
    if (symbol !== undefined) {
      const raw = await this.request<RawPremiumIndex>('/fapi/v1/premiumIndex', { symbol }, { kind: 'weight', weight: 1 })
      return toPremiumIndex(raw)
    }
    const raw = await this.request<RawPremiumIndex[]>('/fapi/v1/premiumIndex', {}, { kind: 'weight', weight: 10 })
    return raw.map(toPremiumIndex)
  }

  async bookTicker(symbol: string): Promise<BookTicker> {
    const raw = await this.request<RawBookTicker>('/fapi/v1/ticker/bookTicker', { symbol }, { kind: 'weight', weight: 2 })
    return { symbol: raw.symbol, bidPrice: num(raw.bidPrice), bidQty: num(raw.bidQty), askPrice: num(raw.askPrice), askQty: num(raw.askQty), time: raw.time }
  }

  // Historial de funding (comparte el límite de 500/5 min con `fundingInfo`).
  async fundingRate(symbol: string, query: FundingRateQuery = {}): Promise<FundingEvent[]> {
    const raw = await this.request<RawFundingRate[]>('/fapi/v1/fundingRate', { symbol, ...query }, { kind: 'funding', weight: 0 })
    return raw
      .map((r) => ({ symbol: r.symbol, at: r.fundingTime, rate: num(r.fundingRate), markPrice: num(r.markPrice) }))
      .sort((a, b) => a.at - b.at)
  }

  async fundingInfo(): Promise<FundingInfo[]> {
    const raw = await this.request<RawFundingInfo[]>('/fapi/v1/fundingInfo', {}, { kind: 'funding', weight: 0 })
    return raw.map((f) => ({
      symbol: f.symbol,
      fundingIntervalHours: f.fundingIntervalHours,
      adjustedFundingRateCap: num(f.adjustedFundingRateCap),
      adjustedFundingRateFloor: num(f.adjustedFundingRateFloor),
    }))
  }

  async openInterestHist(symbol: string, period: DataPeriod, limit: number, range: DataRange = {}): Promise<OpenInterestPoint[]> {
    const raw = await this.request<RawOpenInterestHist[]>('/futures/data/openInterestHist', { symbol, period, limit, ...range }, { kind: 'data', weight: 0 })
    return raw.map((p) => ({ symbol: p.symbol, sumOpenInterest: num(p.sumOpenInterest), sumOpenInterestValue: num(p.sumOpenInterestValue), timestamp: p.timestamp }))
  }

  async globalLongShortAccountRatio(symbol: string, period: DataPeriod, limit: number, range: DataRange = {}): Promise<LongShortRatioPoint[]> {
    const raw = await this.request<RawLongShortRatio[]>('/futures/data/globalLongShortAccountRatio', { symbol, period, limit, ...range }, { kind: 'data', weight: 0 })
    return raw.map((p) => ({ symbol: p.symbol, longShortRatio: num(p.longShortRatio), longAccount: num(p.longAccount), shortAccount: num(p.shortAccount), timestamp: p.timestamp }))
  }

  async takerLongShortRatio(symbol: string, period: DataPeriod, limit: number, range: DataRange = {}): Promise<TakerRatioPoint[]> {
    const raw = await this.request<RawTakerLongShortRatio[]>('/futures/data/takerlongshortRatio', { symbol, period, limit, ...range }, { kind: 'data', weight: 0 })
    return raw.map((p) => ({ buySellRatio: num(p.buySellRatio), buyVol: num(p.buyVol), sellVol: num(p.sellVol), timestamp: p.timestamp }))
  }

  // Hay clave completa (key y secret) para los pedidos firmados.
  hasKey(): boolean {
    return this.http.hasKey()
  }

  // Los brackets de apalancamiento de la cuenta, todas las monedas en un pedido (USER_DATA).
  leverageBrackets(): Promise<RawLeverageBracket[]> {
    return this.http.request<RawLeverageBracket[]>('/fapi/v1/leverageBracket', {}, { kind: 'weight', weight: 1 }, { signed: true })
  }

  // Las comisiones de la cuenta en ese contrato (USER_DATA).
  async commissionRate(symbol: string): Promise<CommissionRate> {
    const raw = await this.http.request<RawCommissionRate>('/fapi/v1/commissionRate', { symbol }, { kind: 'weight', weight: 20 }, { signed: true })
    return toCommissionRate(raw)
  }

  private request<T>(path: string, params: Params, cost: Cost): Promise<T> {
    return this.http.request<T>(path, params, cost)
  }

  private async fetchKlines(path: string, symbol: string, interval: KlineInterval, query: KlineQuery): Promise<Candle[]> {
    const limit = query.limit ?? MAX_KLINES_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KLINES_LIMIT) throw new RangeError(`Binance: limit ${limit} fuera de 1..${MAX_KLINES_LIMIT}`)
    const raw = await this.request<RawKline[]>(path, { symbol, interval, ...query, limit }, { kind: 'weight', weight: klinesWeight(limit) })
    const ms = INTERVAL_MS[interval]
    const now = this.now()
    return raw.map((row) => toCandle(row, ms, now))
  }
}

function toCandle(row: RawKline, intervalMs: number, now: number): Candle {
  const openTime = row[0]
  const closeTime = openTime + intervalMs - 1
  return {
    openTime,
    closeTime,
    open: num(row[1]),
    high: num(row[2]),
    low: num(row[3]),
    close: num(row[4]),
    volume: num(row[5]),
    quoteVolume: num(row[7]),
    // La última fila puede ser la vela en curso: cerrada sólo si su cierre ya pasó.
    closed: closeTime < now,
  }
}

function toContractMeta(s: RawExchangeSymbol): ContractMeta {
  let minNotional = 0
  let minQty = 0
  let stepSize = 0
  let tickSize = 0
  for (const f of s.filters) {
    if (f.filterType === 'MIN_NOTIONAL') minNotional = num(f.notional)
    else if (f.filterType === 'LOT_SIZE') {
      minQty = num(f.minQty)
      stepSize = num(f.stepSize)
    } else if (f.filterType === 'PRICE_FILTER') tickSize = num(f.tickSize)
  }
  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    contractType: s.contractType,
    status: s.status,
    underlyingType: s.underlyingType,
    underlyingSubType: [...(s.underlyingSubType ?? [])],
    onboardDate: s.onboardDate,
    filters: { minNotional, minQty, stepSize, tickSize, quantityPrecision: s.quantityPrecision, liquidationFee: num(s.liquidationFee) },
  }
}

function toPremiumIndex(p: RawPremiumIndex): PremiumIndex {
  return {
    symbol: p.symbol,
    markPrice: num(p.markPrice),
    indexPrice: num(p.indexPrice),
    lastFundingRate: optionalNum(p.lastFundingRate),
    nextFundingTime: p.nextFundingTime > 0 ? p.nextFundingTime : null,
    time: p.time,
  }
}

// Campos que Binance deja vacíos cuando no aplican (p. ej. funding de un contrato sin funding).
function optionalNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
