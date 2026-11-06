import { describe, it, expect } from 'vitest'
import { CandleSeries } from '../../src/market/candle-series'
import { candle, candleRun, utc } from './fixtures'

describe('CandleSeries', () => {
  it('guarda el marco y arranca vacía', () => {
    const s = new CandleSeries('4h')
    expect(s.tf).toBe('4h')
    expect(s.size).toBe(0)
    expect(s.last()).toBeUndefined()
    expect(s.closedUpTo(utc(23, 59))).toEqual([])
  })

  it('mantiene el orden por openTime aunque las velas lleguen desordenadas', () => {
    const s = new CandleSeries('15m')
    const [c0, c1, c2, c3] = candleRun('15m', utc(9), 4)
    for (const c of [c2, c0, c3, c1]) if (c) s.upsert(c)
    expect(s.size).toBe(4)
    expect(s.closedUpTo(utc(10, 30)).map((c) => c.openTime)).toEqual([utc(9), utc(9, 15), utc(9, 30), utc(9, 45)])
    expect(s.last()?.openTime).toBe(utc(9, 45))
  })

  it('upsert de una vela intermedia repetida la reemplaza sin duplicar', () => {
    const s = new CandleSeries('15m')
    for (const c of candleRun('15m', utc(9), 4)) s.upsert(c)
    s.upsert(candle(utc(9, 15), '15m', { close: 123 }))
    expect(s.size).toBe(4)
    expect(s.closedUpTo(utc(10, 30)).map((c) => c.close)).toEqual([100, 123, 100, 100])
  })

  it('closedUpTo devuelve las últimas `limit` velas que cumplen la regla', () => {
    const s = new CandleSeries('15m')
    for (const c of candleRun('15m', utc(9), 8)) s.upsert(c) // 09:00 … 10:45
    expect(s.closedUpTo(utc(10, 0), 2).map((c) => c.openTime)).toEqual([utc(9, 30), utc(9, 45)])
    expect(s.closedUpTo(utc(10, 0), 0)).toEqual([])
    expect(s.closedUpTo(utc(10, 0), 100)).toHaveLength(4)
  })

  it('closedUpTo devuelve un arreglo nuevo cada vez', () => {
    const s = new CandleSeries('1h')
    for (const c of candleRun('1h', utc(0), 3)) s.upsert(c)
    const a = s.closedUpTo(utc(5))
    a.length = 0
    expect(s.closedUpTo(utc(5))).toHaveLength(3)
  })

  it('last devuelve la última vela aunque esté abierta', () => {
    const s = new CandleSeries('15m')
    s.upsert(candle(utc(9, 45), '15m'))
    s.upsert(candle(utc(10, 0), '15m', { closed: false }))
    expect(s.last()?.openTime).toBe(utc(10, 0))
    expect(s.closedUpTo(utc(10, 15)).at(-1)?.openTime).toBe(utc(9, 45))
  })
})
