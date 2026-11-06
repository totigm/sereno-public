import { describe, expect, it } from 'vitest'
import type { ContractMeta } from '@sereno/core'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import {
  DEFAULT_FUNDING_INTERVAL_HOURS,
  FALLBACK_HALF_SPREAD_MAJOR,
  FALLBACK_HALF_SPREAD_OTHER,
  fundingIntervalsOf,
  halfSpreadRate,
  mmrFor,
  toSymbolInfo,
} from '../../src/binance/symbol-info'
import type { BookTicker } from '../../src/binance/types'

const RISK = DEFAULT_SETTINGS.risk

function contract(symbol: string, patch: Partial<ContractMeta> = {}): ContractMeta {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: Date.UTC(2020, 8, 15),
    filters: { minNotional: 5, minQty: 1, stepSize: 1, tickSize: 0.01, quantityPrecision: 0, liquidationFee: 0.0125 },
    ...patch,
  }
}

function book(symbol: string, bidPrice: number, askPrice: number): BookTicker {
  return { symbol, bidPrice, bidQty: 1, askPrice, askQty: 1, time: 0 }
}

describe('mmrFor', () => {
  it('usa la tabla de settings y, si el símbolo no está, el mmr por defecto', () => {
    expect(mmrFor('BTCUSDT', RISK)).toBe(0.004)
    expect(mmrFor('ETHUSDT', RISK)).toBe(0.005)
    expect(mmrFor('SOLUSDT', RISK)).toBe(0.02)
    expect(mmrFor('SOLUSDT', { mmrBySymbol: { SOLUSDT: 0.01 }, mmrDefault: 0.03 })).toBe(0.01)
  })
})

describe('fundingIntervalsOf', () => {
  it('indexa fundingInfo por símbolo', () => {
    const intervals = fundingIntervalsOf([
      { symbol: 'SOLUSDT', fundingIntervalHours: 4, adjustedFundingRateCap: 0.02, adjustedFundingRateFloor: -0.02 },
      { symbol: 'PEPEUSDT', fundingIntervalHours: 1, adjustedFundingRateCap: 0.02, adjustedFundingRateFloor: -0.02 },
    ])
    expect(intervals.get('SOLUSDT')).toBe(4)
    expect(intervals.get('PEPEUSDT')).toBe(1)
    expect(intervals.has('BTCUSDT')).toBe(false)
  })
})

describe('halfSpreadRate', () => {
  it('es (ask − bid) / (2 × mid) con el libro presente', () => {
    // mid = 100, spread = 0,2 ⇒ medio spread relativo 0,1 %.
    expect(halfSpreadRate('SOLUSDT', book('SOLUSDT', 99.9, 100.1))).toBeCloseTo(0.001, 12)
    expect(halfSpreadRate('BTCUSDT', book('BTCUSDT', 68_000, 68_000.1))).toBeCloseTo(0.1 / (2 * 68_000.05), 15)
  })

  it('sin libro usa los supuestos de la spec §6: 0,01 % en BTC y ETH, 0,025 % en el resto', () => {
    expect(FALLBACK_HALF_SPREAD_MAJOR).toBe(0.0001)
    expect(FALLBACK_HALF_SPREAD_OTHER).toBe(0.00025)
    expect(halfSpreadRate('BTCUSDT', null)).toBe(0.0001)
    expect(halfSpreadRate('ETHUSDT', undefined)).toBe(0.0001)
    expect(halfSpreadRate('SOLUSDT', null)).toBe(0.00025)
  })

  it('un libro inutilizable (vacío, cruzado o sin precio) cuenta como faltante', () => {
    expect(halfSpreadRate('SOLUSDT', book('SOLUSDT', 0, 100))).toBe(0.00025)
    expect(halfSpreadRate('SOLUSDT', book('SOLUSDT', 100, 100))).toBe(0.00025)
    expect(halfSpreadRate('SOLUSDT', book('SOLUSDT', 100.1, 99.9))).toBe(0.00025)
    expect(halfSpreadRate('BTCUSDT', book('BTCUSDT', Number.NaN, 68_000))).toBe(0.0001)
  })

  it('sin libro, la mediana observada en `symbols.observedSpread` reemplaza al supuesto (spec §6)', () => {
    expect(halfSpreadRate('SOLUSDT', null, 0.0004)).toBe(0.0004)
    expect(halfSpreadRate('BTCUSDT', book('BTCUSDT', 100, 100), 0.00003)).toBe(0.00003)
    // Con libro manda el libro; una observación nula o inválida no cuenta.
    expect(halfSpreadRate('SOLUSDT', book('SOLUSDT', 99.9, 100.1), 0.0004)).toBeCloseTo(0.001, 12)
    expect(halfSpreadRate('SOLUSDT', null, null)).toBe(0.00025)
    expect(halfSpreadRate('SOLUSDT', null, 0)).toBe(0.00025)
    expect(halfSpreadRate('SOLUSDT', null, Number.NaN)).toBe(0.00025)
  })

  it('rechaza el libro de otro símbolo', () => {
    expect(() => halfSpreadRate('SOLUSDT', book('ETHUSDT', 99.9, 100.1))).toThrow(RangeError)
  })
})

describe('toSymbolInfo', () => {
  it('aplana el contrato con mmr de settings, intervalo de funding y medio spread del libro', () => {
    const sol = contract('SOLUSDT', { underlyingSubType: ['Layer-1', 'Solana'] })
    const info = toSymbolInfo(sol, { risk: RISK, fundingIntervals: new Map([['SOLUSDT', 4]]), book: book('SOLUSDT', 99.9, 100.1) })
    expect(info).toEqual({
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
      minNotional: 5,
      minQty: 1,
      stepSize: 1,
      tickSize: 0.01,
      quantityPrecision: 0,
      mmr: 0.02,
      liquidationFee: 0.0125,
      fundingIntervalHours: 4,
      halfSpreadRate: info.halfSpreadRate,
      underlyingType: 'COIN',
      underlyingSubType: ['Layer-1', 'Solana'],
      onboardDate: Date.UTC(2020, 8, 15),
    })
    expect(info.halfSpreadRate).toBeCloseTo(0.001, 12)
    // Copia: el SymbolInfo no comparte el arreglo con el contrato.
    expect(info.underlyingSubType).not.toBe(sol.underlyingSubType)
  })

  it('sin fundingInfo del símbolo el intervalo es 8 h y sin libro el spread es el supuesto', () => {
    const info = toSymbolInfo(contract('BTCUSDT'), { risk: RISK, fundingIntervals: new Map() })
    expect(DEFAULT_FUNDING_INTERVAL_HOURS).toBe(8)
    expect(info.fundingIntervalHours).toBe(8)
    expect(info.mmr).toBe(0.004)
    expect(info.halfSpreadRate).toBe(0.0001)
  })

  it('sin libro toma el medio spread observado del símbolo', () => {
    const info = toSymbolInfo(contract('SOLUSDT'), { risk: RISK, fundingIntervals: new Map(), book: null, observedHalfSpread: 0.0004 })
    expect(info.halfSpreadRate).toBe(0.0004)
  })
})
