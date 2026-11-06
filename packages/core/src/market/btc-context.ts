import { realizedVol } from '../indicators/realized-vol'
import type { BtcContext } from '../types'
import type { CandleSeries } from './candle-series'

// Velas de 15m en un día y días de la media de referencia (spec §5.3c:
// "volatilidad realizada 24h > 2 × su media de 30 días").
export const CANDLES_15M_PER_DAY = 96
export const BTC_VOL_BASELINE_DAYS = 30
// Cierres de 15m de BTC que necesita la media de 30 días: 30 ventanas disjuntas de 96
// retornos son 2880 retornos, o sea 2881 cierres. Quien alimenta el motor tiene que
// calentar al menos esto (más que el calentamiento general de 300).
export const BTC_15M_CANDLES_FOR_BASELINE = CANDLES_15M_PER_DAY * BTC_VOL_BASELINE_DAYS + 1
// Ventanas finitas que necesita la media: una vela mala (un cierre no positivo) arruina
// sólo su ventana, y no tiene que apagar el filtro de volatilidad extrema por 30 días.
export const BTC_VOL_BASELINE_MIN_WINDOWS = 27

export interface BtcContextInput {
  t: number
  btc4h: CandleSeries
  btc15m: CandleSeries
  warmup4h: number
}

/**
 * Contexto de BTC visto desde `t`: velas de 4h cerradas (para el régimen) y la volatilidad
 * realizada sobre 15m, ambas con la regla de causalidad (velas cerradas con `closeTime ≤ t`).
 *
 * Convención de la volatilidad: `realizedVol24h` y `realizedVol30dMean` son volatilidad
 * **diaria, no anualizada**: el desvío muestral de 96 log-retornos de 15m × √96, tal como lo
 * calcula `indicators/realizedVol(closes, 96, 96)`. La de 24h es la ventana que termina en la
 * última vela cerrada ≤ t; la media de 30 días promedia esa y las 29 ventanas anteriores,
 * disjuntas en retornos (cada una empieza en el cierre donde termina la anterior), salteando
 * las que no dan un valor finito si quedan al menos `BTC_VOL_BASELINE_MIN_WINDOWS`. Las dos
 * cifras están en la misma escala, así que el cociente del filtro no depende de ella.
 *
 * Precondición: `btc15m` sin huecos. Las ventanas cuentan velas, no tiempo; si falta una vela,
 * "24h" abarca más de un día. Quien carga la historia de BTC tiene que completarla.
 */
export function buildBtcContext({ t, btc4h, btc15m, warmup4h }: BtcContextInput): BtcContext {
  const closes = btc15m.closedUpTo(t, BTC_15M_CANDLES_FOR_BASELINE).map((c) => c.close)
  return {
    candles4h: btc4h.closedUpTo(t, warmup4h),
    realizedVol24h: dailyVolEndingAt(closes, closes.length - 1),
    realizedVol30dMean: dailyVol30dMean(closes),
  }
}

// null hasta tener los 30 días de historia: una media sobre menos días no es "la media de
// 30 días", y mientras falte historia el filtro de volatilidad extrema no se aplica (tamaño
// completo). Con la historia completa, también null si quedan menos de 27 ventanas finitas.
function dailyVol30dMean(closes: readonly number[]): number | null {
  if (closes.length < BTC_15M_CANDLES_FOR_BASELINE) return null
  let sum = 0
  let windows = 0
  for (let day = 0; day < BTC_VOL_BASELINE_DAYS; day++) {
    const vol = dailyVolEndingAt(closes, closes.length - 1 - day * CANDLES_15M_PER_DAY)
    if (vol === null) continue
    sum += vol
    windows++
  }
  return windows >= BTC_VOL_BASELINE_MIN_WINDOWS ? sum / windows : null
}

// Volatilidad diaria de los 96 retornos que terminan en el cierre `end`, o null si no hay
// 97 cierres o el resultado no es finito (un cierre no positivo). Se le pasa al indicador
// sólo la ventana para calcular un valor y no los 2881.
function dailyVolEndingAt(closes: readonly number[], end: number): number | null {
  const start = end - CANDLES_15M_PER_DAY
  if (start < 0) return null
  const vol = realizedVol(closes.slice(start, end + 1), CANDLES_15M_PER_DAY, CANDLES_15M_PER_DAY).at(-1)
  return vol !== undefined && Number.isFinite(vol) ? vol : null
}
