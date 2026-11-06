import type { Candle, SymbolInfo, Timeframe } from '../../src/types'

export const TF_MS: Record<Timeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

// Todos los tests usan el 2026-10-31 en UTC; `utc(10, 15)` es "las 10:15 de ese día".
export const utc = (h: number, m = 0, s = 0, ms = 0): number => Date.UTC(2026, 9, 31, h, m, s, ms)

export function candle(openTime: number, tf: Timeframe, overrides: Partial<Candle> = {}): Candle {
  return {
    openTime,
    closeTime: openTime + TF_MS[tf] - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    quoteVolume: 1_000,
    closed: true,
    ...overrides,
  }
}

// `count` velas consecutivas y cerradas de `tf` desde `firstOpenTime`. Con `closeOf`
// el precio de cada vela (open/high/low/close) es `closeOf(i)`, para series deterministas.
export function candleRun(tf: Timeframe, firstOpenTime: number, count: number, closeOf?: (i: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = firstOpenTime + i * TF_MS[tf]
    if (closeOf === undefined) return candle(openTime, tf)
    const price = closeOf(i)
    return candle(openTime, tf, { open: price, high: price, low: price, close: price })
  })
}

export function symbolInfo(symbol = 'ETHUSDT'): SymbolInfo {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    minNotional: 5,
    minQty: 0.001,
    stepSize: 0.001,
    tickSize: 0.01,
    quantityPrecision: 3,
    mmr: 0.004,
    liquidationFee: 0.0125,
    fundingIntervalHours: 8,
    halfSpreadRate: 0.0001,
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: Date.UTC(2019, 10, 27),
  }
}
