// Modificadores no aprendibles (spec §5.3b y §5.3c).
// De S: S′ = S × mADX × mVol. De tamaño: el multiplicador de BTC (mBTC) y la confianza
// a la mitad con un solo marco mayor en contra; los consume el plan de entrada (§5.5).
import type { BtcContext, Candle, Composite } from '../types'
import { clamp } from './result'

export const ADX_PERIOD = 14
const ADX_WEAK = 20
const ADX_STRONG = 40
export const REL_VOLUME_WINDOW = 96
const VOL_MIN = 0.7
const VOL_MAX = 1.2
const BTC_EXTREME_VOL_MULTIPLE = 2

// 0,5 con ADX < 20, 1 entre 20 y 40 (inclusive), 1,1 por encima de 40. Sin dato no modifica.
export function adxModifier(adxValue: number | null): number {
  if (adxValue === null || !Number.isFinite(adxValue)) return 1
  if (adxValue < ADX_WEAK) return 0.5
  return adxValue > ADX_STRONG ? 1.1 : 1
}

export function volumeModifier(relVolume: number): number {
  return Number.isFinite(relVolume) ? clamp(relVolume, VOL_MIN, VOL_MAX) : 1
}

// Volumen de la última vela sobre la media de las 96 anteriores (24 h de 15m), sin incluirla:
// la vela no se compara contra sí misma. null sin 96 velas previas o con media no positiva.
export function relativeVolume(candles: readonly Candle[]): number | null {
  if (candles.length <= REL_VOLUME_WINDOW) return null
  const current = candles.at(-1)!.volume
  const window = candles.slice(-REL_VOLUME_WINDOW - 1, -1)
  const mean = window.reduce((acc, c) => acc + c.volume, 0) / REL_VOLUME_WINDOW
  if (!(mean > 0)) return null
  const ratio = current / mean
  return Number.isFinite(ratio) && ratio >= 0 ? ratio : null
}

// mBTC: 0,5 si la volatilidad realizada 24h de BTC supera 2 × su media de 30 días; 1 si no
// o mientras falte historia (el filtro no se aplica sin la media de 30 días).
export function btcVolatilityMultiplier(btc: BtcContext): 0.5 | 1 {
  const { realizedVol24h, realizedVol30dMean } = btc
  if (realizedVol24h === null || realizedVol30dMean === null) return 1
  return realizedVol24h > BTC_EXTREME_VOL_MULTIPLE * realizedVol30dMean ? 0.5 : 1
}

// La confianza que entra al tamaño (mConfianza = 0,6 + 0,4·c): a la mitad si algún marco mayor
// está en contra. Con los dos en contra la entrada ya la bloquea `entryFilters`.
export function sizingConfidence(composite: Composite): number {
  return composite.higherTrendAgainst === 0 ? composite.confidence : composite.confidence / 2
}
