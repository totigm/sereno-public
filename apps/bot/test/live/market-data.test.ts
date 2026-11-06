import { describe, expect, it } from 'vitest'
import type { Candle } from '@sereno/core'
import { BTC_15M_CANDLES_FOR_BASELINE } from '@sereno/core/src/market/btc-context'
import { INTERVAL_MS } from '../../src/binance/types'
import { MarketData } from '../../src/live/market-data'
import type { WarmedSymbol } from '../../src/live/warmup'

const M15 = INTERVAL_MS['15m']
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0)
const LIMITS = { '15m': 10, '1h': 10, '4h': 10 }

function candle(i: number, closed = true): Candle {
  const openTime = T0 + i * M15
  return { openTime, closeTime: openTime + M15 - 1, open: 100, high: 101, low: 99, close: 100 + i, volume: 1, quoteVolume: 100, closed }
}

function warmed(count: number): WarmedSymbol {
  const last = Array.from({ length: count }, (_, i) => candle(i))
  return { '15m': { last, mark: [] }, '1h': { last: [], mark: [] }, '4h': { last: [], mark: [] } }
}

describe('MarketData', () => {
  it('una vela del stream sola no deja una moneda caliente: hace falta su historia', () => {
    const market = new MarketData(LIMITS)
    market.addCandle('SOLUSDT', '15m', candle(0, false), T0)
    expect(market.isWarm('SOLUSDT')).toBe(false)
    market.load('SOLUSDT', warmed(5))
    expect(market.isWarm('SOLUSDT')).toBe(true)
  })

  it('recorta cada serie a la ventana más un día y conserva la vela en curso', () => {
    const market = new MarketData(LIMITS)
    market.load('SOLUSDT', warmed(300))
    market.addCandle('SOLUSDT', '15m', candle(300, false), T0)
    market.addMark({ symbol: 'SOLUSDT', markPrice: 400, lastPrice: 400, at: T0, fundingRate: null, nextFundingTime: null }, T0)
    market.trim()
    // Quedan 10 + 96 cerradas (de la 194 a la 299): el cambio de 24 h llega hasta la 194.
    expect(market.change24h('SOLUSDT', T0 + 291 * M15)).toBeCloseTo((400 - 294) / 294, 9)
    expect(market.change24h('SOLUSDT', T0 + 290 * M15)).toBeNull()
    // La vela en curso sigue ahí: al cerrar reemplaza a la abierta.
    market.addCandle('SOLUSDT', '15m', candle(300), T0)
    expect(market.closedBetween('SOLUSDT', '15m', T0 + 299 * M15, T0 + 301 * M15).map((c) => c.close)).toEqual([399, 400])
  })

  it('en BTC 15m conserva además la base de volatilidad', () => {
    const market = new MarketData(LIMITS)
    const count = BTC_15M_CANDLES_FOR_BASELINE + 200
    market.load('BTCUSDT', warmed(count))
    market.trim()
    const btc = market.btcContext(T0 + count * M15)
    const untrimmed = new MarketData(LIMITS)
    untrimmed.load('BTCUSDT', warmed(count))
    expect(btc).toEqual(untrimmed.btcContext(T0 + count * M15))
  })

  it('olvidar una moneda borra sus series: si vuelve, se calienta de nuevo', () => {
    const market = new MarketData(LIMITS)
    market.load('SOLUSDT', warmed(5))
    market.forget(['SOLUSDT'])
    expect(market.isWarm('SOLUSDT')).toBe(false)
    expect(market.closedBetween('SOLUSDT', '15m', 0, T0 + 10 * M15)).toEqual([])
  })
})
