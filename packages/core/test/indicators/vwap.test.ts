import { describe, it, expect } from 'vitest'
import { vwapDaily, utcDayStart } from '../../src/indicators/vwap'
import type { Candle } from '../../src/types'
import { fixtureCandles, expected, candleAt } from './synthetic'

const FOUR_HOURS_MS = 4 * 3_600_000

/** Vela de 4h que abre en `openTime` con precio típico `typical` (high = low = close). */
function fourHourCandle(openTime: number, typical: number, volume: number): Candle {
  return {
    openTime,
    closeTime: openTime + FOUR_HOURS_MS - 1,
    open: typical,
    high: typical,
    low: typical,
    close: typical,
    volume,
    quoteVolume: typical * volume,
    closed: true,
  }
}

describe('vwapDaily', () => {
  it('utcDayStart devuelve la medianoche UTC del día del instante', () => {
    expect(utcDayStart(Date.UTC(2026, 9, 1, 20, 15))).toBe(Date.UTC(2026, 9, 1))
    expect(utcDayStart(Date.UTC(2026, 9, 1))).toBe(Date.UTC(2026, 9, 1))
    expect(utcDayStart(Date.UTC(2026, 9, 1, 23, 59, 59, 999))).toBe(Date.UTC(2026, 9, 1))
  })

  it('acumula precio típico × volumen dentro del día y se reinicia al cambiar el día UTC', () => {
    // El fixture arranca a las 20:00 UTC: velas 0..3 en el día 1, 4..27 en el día 2, 28.. en el día 3.
    const out = vwapDaily(fixtureCandles, utcDayStart)
    expect(out).toHaveLength(60)
    expect(out[3]).toBeCloseTo(expected.vwap_at3, 10)
    expect(out[4]).toBeCloseTo(expected.vwap_at4, 10)
    expect(out[27]).toBeCloseTo(expected.vwap_at27, 10)
    expect(out[28]).toBeCloseTo(expected.vwap_at28, 10)
    expect(out[30]).toBeCloseTo(expected.vwap_at30, 10)
  })

  it('la primera vela del día vale su precio típico (high + low + close) / 3', () => {
    const out = vwapDaily(fixtureCandles, utcDayStart)
    const c4 = fixtureCandles[4]!
    expect(out[4]).toBeCloseTo((c4.high + c4.low + c4.close) / 3, 12)
  })

  it('una vela que cruza la medianoche UTC cuenta para el día en que abrió', () => {
    const candles = [
      fourHourCandle(Date.UTC(2026, 9, 1, 18), 10, 1),
      fourHourCandle(Date.UTC(2026, 9, 1, 22), 20, 1), // 22:00 → 02:00: sigue en el 1 de octubre
      fourHourCandle(Date.UTC(2026, 9, 2, 2), 30, 1), // primera vela que abre el 2: reinicia
    ]
    const out = vwapDaily(candles, utcDayStart)
    expect(out[1]).toBe(15)
    expect(out[2]).toBe(30)
  })

  it('a mano: dos velas del mismo día con volúmenes 1 y 3', () => {
    const candles = [
      candleAt(0, { open: 10, high: 12, low: 8, close: 10 }, 1), // típico 10
      candleAt(1, { open: 10, high: 22, low: 18, close: 20 }, 3), // típico 20
    ]
    const out = vwapDaily(candles, utcDayStart)
    expect(out[0]).toBe(10)
    expect(out[1]).toBeCloseTo((10 * 1 + 20 * 3) / 4, 12) // 17,5
  })

  it('sin volumen acumulado en el día devuelve NaN hasta que aparezca volumen', () => {
    const candles = [
      candleAt(0, { open: 10, high: 12, low: 8, close: 10 }, 0),
      candleAt(1, { open: 10, high: 12, low: 8, close: 10 }, 5),
    ]
    const out = vwapDaily(candles, utcDayStart)
    expect(Number.isNaN(out[0])).toBe(true)
    expect(out[1]).toBe(10)
  })

  it('no hay calentamiento: devuelve un valor desde la primera vela', () => {
    expect(vwapDaily([], utcDayStart)).toEqual([])
    expect(Number.isNaN(vwapDaily(fixtureCandles, utcDayStart)[0]!)).toBe(false)
  })
})
