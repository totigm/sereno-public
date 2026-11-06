// Funding (spec §5.3a): tasa actual `r` normalizada a un período de 8 h, contrarian suave.
//   r8    = r × 8 / fundingIntervalHours
//   valor = −sgn(r8) × 0,5 × clamp((|r8| − 0,05 %) / (0,08 % − 0,05 %), 0, 1)
// Signo: + = long. Un funding alto positivo (los longs pagan) resta a los longs hasta −0,5;
// uno alto negativo resta a los shorts. Hasta ±0,05 % por 8 h no aporta. null sin tasa.
import type { MarketView, SignalResult } from '../types'
import { clamp, noData, signalResult } from './result'

const REFERENCE_HOURS = 8
const DEAD_BAND = 0.0005
const SATURATION = 0.0008
const MAX_ABS_VALUE = 0.5

export function fundingValue(ratePer8h: number): number {
  const excess = clamp((Math.abs(ratePer8h) - DEAD_BAND) / (SATURATION - DEAD_BAND), 0, 1)
  return excess === 0 ? 0 : -Math.sign(ratePer8h) * MAX_ABS_VALUE * excess
}

export function funding(view: MarketView): SignalResult {
  const rate = view.futures?.fundingRate ?? null
  const intervalHours = view.info.fundingIntervalHours
  if (rate === null || !Number.isFinite(rate) || !(intervalHours > 0)) return noData('funding')
  const ratePer8h = (rate * REFERENCE_HOURS) / intervalHours
  const annualized = rate * (24 / intervalHours) * 365
  return signalResult('funding', fundingValue(ratePer8h), { rate, ratePer8h, annualized })
}
