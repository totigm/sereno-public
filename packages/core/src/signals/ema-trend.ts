// Puntaje de tendencia por EMAs, compartido por trend15m, trendHigher y btcRegime.
//   puntaje = (sgn(EMA20 − EMA50) + sgn(EMA50 − EMA200) + sgn(EMA20[i] − EMA20[i − 1])) / 3
// Signo: + = alcista (long). +1 si se cumplen las tres condiciones alcistas, −1 las tres
// bajistas, intermedio proporcional; una igualdad aporta 0.
// null sin 200 cierres (EMA200 en calentamiento) o con algún valor no finito.
import { ema } from '../indicators/ema'

export interface EmaTrend {
  score: number
  ema20: number
  ema50: number
  ema200: number
  slope20: number
}

export function emaTrend(closes: readonly number[]): EmaTrend | null {
  const last = closes.length - 1
  if (last < 1) return null
  const e20 = ema(closes, 20)
  const ema20 = e20[last]!
  const ema50 = ema(closes, 50)[last]!
  const ema200 = ema(closes, 200)[last]!
  const slope20 = ema20 - e20[last - 1]!
  if (![ema20, ema50, ema200, slope20].every(Number.isFinite)) return null
  const score = (Math.sign(ema20 - ema50) + Math.sign(ema50 - ema200) + Math.sign(slope20)) / 3
  return { score, ema20, ema50, ema200, slope20 }
}

export function emaTrendScore(closes: readonly number[]): number | null {
  return emaTrend(closes)?.score ?? null
}
