import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '@sereno/core'
import type { DirectDb } from '../../src/client'
import { createCandlesRepo } from '../../src/repos/candles'
import { createFuturesRepo, type FuturesPoint } from '../../src/repos/futures'
import { createSymbolsRepo, type SymbolUpsert } from '../../src/repos/symbols'
import { candles, futuresData, symbols } from '../../src/schema'
import { openTestDb, truncate } from './helpers'

const Q = 15 * 60_000
const T = Date.parse('2026-10-31T00:00:00Z')
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, candles, futuresData, symbols)
})

function candle(openTime: number, close: number, closed = true): Candle {
  return { openTime, closeTime: openTime + Q - 1, open: 100, high: 110, low: 90, close, volume: 5, quoteVolume: 500, closed }
}

describe('candlesRepo', () => {
  it('upsertMany guarda y range devuelve [from, to) en orden, separado por marco y tipo de precio', async () => {
    const repo = createCandlesRepo(db)
    await repo.upsertMany({ symbol: 'SOLUSDT', timeframe: '15m', priceType: 'last' }, [candle(T + Q, 102), candle(T, 101)])
    await repo.upsertMany({ symbol: 'SOLUSDT', timeframe: '15m', priceType: 'mark' }, [candle(T, 999)])
    await repo.upsertMany({ symbol: 'SOLUSDT', timeframe: '1h', priceType: 'last' }, [candle(T, 888)])
    expect(await repo.range('SOLUSDT', '15m', 'last', T, T + 2 * Q)).toEqual([candle(T, 101), candle(T + Q, 102)])
    expect((await repo.range('SOLUSDT', '15m', 'last', T, T + Q)).map((c) => c.close)).toEqual([101])
    expect((await repo.range('SOLUSDT', '15m', 'mark', T, T + 2 * Q)).map((c) => c.close)).toEqual([999])
  })

  it('una vela abierta se reescribe hasta cerrar, aunque venga repetida en el lote', async () => {
    const repo = createCandlesRepo(db)
    const key = { symbol: 'SOLUSDT', timeframe: '15m', priceType: 'last' } as const
    await repo.upsertMany(key, [candle(T, 100, false)])
    await repo.upsertMany(key, [candle(T, 101, false), candle(T, 103, true)])
    expect(await repo.range('SOLUSDT', '15m', 'last', T, T + Q)).toEqual([candle(T, 103, true)])
  })
})

describe('futuresRepo', () => {
  function punto(at: number, patch: Partial<FuturesPoint> = {}): FuturesPoint {
    return {
      symbol: 'SOLUSDT',
      at,
      fundingRate: 0.0001,
      nextFundingTime: T + 8 * 3_600_000,
      openInterest: 1_000_000,
      longShortRatio: 1.2,
      takerRatio: 0.9,
      ...patch,
    }
  }

  it('insert, latest (con y sin corte) y range', async () => {
    const repo = createFuturesRepo(db)
    await repo.insert([punto(T), punto(T + 5 * 60_000, { openInterest: 1_100_000 }), punto(T, { symbol: 'BTCUSDT' })])
    expect(await repo.latest('SOLUSDT')).toEqual(punto(T + 5 * 60_000, { openInterest: 1_100_000 }))
    expect((await repo.latest('SOLUSDT', T + 60_000))?.at).toBe(T)
    expect(await repo.latest('SOLUSDT', T - 1)).toBeNull()
    expect((await repo.range('SOLUSDT', T, T + 5 * 60_000)).map((p) => p.at)).toEqual([T])
  })

  it('un null nuevo no borra un valor que ya estaba en el mismo instante', async () => {
    const repo = createFuturesRepo(db)
    await repo.insert(punto(T, { longShortRatio: null, takerRatio: null }))
    await repo.insert(punto(T, { fundingRate: null, nextFundingTime: null, openInterest: 2_000_000 }))
    expect(await repo.latest('SOLUSDT')).toEqual(punto(T, { openInterest: 2_000_000 }))
  })
})

describe('symbolsRepo', () => {
  function contrato(symbol: string, patch: Partial<SymbolUpsert> = {}): SymbolUpsert {
    return {
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      minNotional: 5,
      minQty: 0.01,
      stepSize: 0.01,
      tickSize: 0.001,
      quantityPrecision: 2,
      underlyingType: 'COIN',
      underlyingSubType: ['Layer-1'],
      onboardDate: Date.parse('2020-09-14T00:00:00Z'),
      fundingIntervalHours: 8,
      liquidationFee: 0.015,
      mmr: 0.02,
      ...patch,
    }
  }

  it('upsertMany refresca los filtros sin borrar el spread observado', async () => {
    const repo = createSymbolsRepo(db)
    await repo.upsertMany([contrato('SOLUSDT'), contrato('BTCUSDT', { mmr: 0.004 })])
    expect(await repo.setObservedSpread('SOLUSDT', 0.0002)).toBe(true)
    expect(await repo.setObservedSpread('NOPEUSDT', 0.0002)).toBe(false)
    await repo.upsertMany([contrato('SOLUSDT', { minNotional: 10, fundingIntervalHours: 4 })])
    const [btc, sol] = await repo.all()
    expect(btc).toMatchObject({ ...contrato('BTCUSDT', { mmr: 0.004 }), observedSpread: null })
    expect(sol).toMatchObject({ ...contrato('SOLUSDT', { minNotional: 10, fundingIntervalHours: 4 }), observedSpread: 0.0002 })
    expect(typeof sol?.updatedAt).toBe('number')
  })
})
