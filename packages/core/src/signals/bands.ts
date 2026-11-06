// Bandas (spec §5.3a): Bollinger(20, 2) en 15m, media-reversión suave.
//   posición = 2 · %B − 1   (−1 en la banda inferior, +1 en la superior)
//   valor    = clamp(−posición / 2, −0,5, +0,5)
// Signo: + = long (cerca de la banda inferior), − = short (cerca de la superior).
// null sin 20 velas o con banda de ancho cero (%B no existe).
import { bollinger } from '../indicators/bollinger'
import type { MarketView, SignalResult } from '../types'
import { clamp, closesOf, noData, signalResult } from './result'

const PERIOD = 20
const MULT = 2

export function bands(view: MarketView): SignalResult {
  const closes = closesOf(view.candles['15m'])
  const last = closes.length - 1
  if (last < 0) return noData('bands')
  const band = bollinger(closes, PERIOD, MULT)
  const pctB = band.pctB[last]!
  if (!Number.isFinite(pctB)) return noData('bands')
  const position = 2 * pctB - 1
  return signalResult('bands', clamp(-position / 2, -0.5, 0.5), {
    pctB,
    upper: band.upper[last]!,
    middle: band.middle[last]!,
    lower: band.lower[last]!,
  })
}
