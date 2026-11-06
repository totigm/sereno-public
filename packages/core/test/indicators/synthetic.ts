// Series sintéticas deterministas para los tests de indicadores. Nada de azar:
// cada serie sale de una fórmula cerrada en el índice `i`, así los valores
// esperados se pueden calcular a mano (o con un oráculo independiente).
import type { Candle } from '../../src/types'
import fixture from '../fixtures/indicators.json'

export const HOUR_MS = 3_600_000

/** Inicio del fixture: 2026-10-01T20:00:00Z (día UTC incompleto al principio: 4 velas de 1h). */
export const FIXTURE_T0 = Date.UTC(2026, 9, 1, 20)

/**
 * Fórmula del fixture de 60 velas de 1h (`test/fixtures/indicators.json`):
 *
 *   close(i) = 100 + 0,5·i + ((3·i) mod 7)          tendencia suave + ciclo de 7
 *   open(i)  = i === 0 ? 100 : close(i − 1)
 *   high(i)  = max(open, close) + 1 + (i mod 3)       mechas asimétricas para que
 *   low(i)   = min(open, close) − 1 − ((2·i) mod 3)   existan +DM y −DM
 *   volume(i)= 1000 + 100·(i mod 5)
 *   quoteVolume(i) = volume(i) · close(i)
 *   openTime(i) = T0 + i·1h; closeTime = openTime + 1h − 1 ms; closed = true
 */
export function syntheticCandle(i: number): Candle {
  const close = syntheticClose(i)
  const open = i === 0 ? 100 : syntheticClose(i - 1)
  const volume = 1000 + 100 * (i % 5)
  return {
    openTime: FIXTURE_T0 + i * HOUR_MS,
    closeTime: FIXTURE_T0 + (i + 1) * HOUR_MS - 1,
    open,
    high: Math.max(open, close) + 1 + (i % 3),
    low: Math.min(open, close) - 1 - ((2 * i) % 3),
    close,
    volume,
    quoteVolume: volume * close,
    closed: true,
  }
}

export function syntheticClose(i: number): number {
  return 100 + 0.5 * i + ((3 * i) % 7)
}

/** Las 60 velas del fixture (JSON) y los valores esperados del oráculo. */
export const fixtureCandles: Candle[] = fixture.candles
export const fixtureCloses: number[] = fixtureCandles.map((c) => c.close)
export const expected = fixture.expected

/** Velas idénticas y planas: open = close = `price`, high = price + halfRange, low = price − halfRange. */
export function flatCandles(count: number, price = 100, halfRange = 1): Candle[] {
  return Array.from({ length: count }, (_, i) => candleAt(i, { open: price, high: price + halfRange, low: price - halfRange, close: price }))
}

/** Tendencia perfectamente lineal: close = start + slope·i, con mechas de ±1. */
export function linearTrendCandles(count: number, start = 100, slope = 1): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start + slope * i
    const open = i === 0 ? close : start + slope * (i - 1)
    return candleAt(i, { open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close })
  })
}

/** Serie de cierres constante. */
export function constantSeries(count: number, value = 100): number[] {
  return Array.from({ length: count }, () => value)
}

/** Serie de cierres lineal: start + slope·i. */
export function linearSeries(count: number, start = 100, slope = 1): number[] {
  return Array.from({ length: count }, (_, i) => start + slope * i)
}

/** Vela de 1h en el índice `i` del reloj del fixture con el OHLC indicado y volumen 1000. */
export function candleAt(i: number, ohlc: { open: number; high: number; low: number; close: number }, volume = 1000): Candle {
  return {
    openTime: FIXTURE_T0 + i * HOUR_MS,
    closeTime: FIXTURE_T0 + (i + 1) * HOUR_MS - 1,
    ...ohlc,
    volume,
    quoteVolume: volume * ohlc.close,
    closed: true,
  }
}

/** Cuántos valores iniciales son NaN (largo del calentamiento). */
export function leadingNaNs(values: number[]): number {
  const first = values.findIndex((v) => !Number.isNaN(v))
  return first === -1 ? values.length : first
}
