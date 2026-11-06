import type { Settings } from '@sereno/shared'
import type { BlockReason, EntryPlan, Side, SymbolInfo } from '../types'
import { roundTripCost } from './costs'
import { EPSILON } from './epsilon'
import { LIQUIDATION_STOP_MULTIPLE, liquidationFarEnough, liquidationPrice } from './liquidation'

export type PlanResult = { ok: true; plan: EntryPlan } | { ok: false; reason: BlockReason }

export interface Multipliers {
  confidence: number
  symbol: number
  btc: number
}

export interface EntryInput {
  side: Side
  price: number
  atr1h: number
  info: SymbolInfo
  capitalBase: number
  capitalOperable: number
  settings: Pick<Settings, 'risk' | 'exits'>
  multipliers: Multipliers
  theta: number
}

export interface CustomEntryInput {
  side: Side
  price: number
  info: SymbolInfo
  capitalBase: number
  capitalOperable: number
  settings: Pick<Settings, 'custom'>
  theta: number
}

// Si el redondeo al step dejara el riesgo real por encima de este múltiplo del
// riesgo buscado, no se abre (spec §5.5). Con redondeo hacia abajo el riesgo real
// nunca supera al buscado, así que hoy es una guarda: protege la invariante del 1%
// si algún día el redondeo deja de ser `floor`.
export const RISK_ROUNDING_TOLERANCE = 1.5

const NO_MULTIPLIERS: Multipliers = { confidence: 1, symbol: 1, btc: 1 }

// Modo "el bot decide todo" (spec §5.5): el tamaño sale del riesgo y el
// apalancamiento del stop, en el orden del documento. Además el stop se lleva al
// tick antes de elegir L, porque el invariante de liquidación se mide con él.
export function planEntry(input: EntryInput): PlanResult {
  const { side, price, atr1h, info, capitalBase, capitalOperable, theta } = input
  const { risk, exits } = input.settings
  if (!isPositive(price) || !Number.isFinite(atr1h) || atr1h < 0) return blocked('no_candle')
  if (!contractUsable(info)) return blocked('degraded')
  if (!isPositive(capitalBase)) return blocked('insufficient_capital')

  const atrDistance = (exits.k * atr1h) / price
  const floorDistance = exits.stopFloorCostMultiple * roundTripCost(info, risk)
  if (floorDistance > 2 * atrDistance) return blocked('stop_too_small_for_cost')
  const targetDistance = Math.max(atrDistance, floorDistance)
  if (!isPositive(targetDistance)) return blocked('stop_too_small_for_cost')

  // El stop redondeado al tick puede quedar hasta un tick por debajo del piso de costo: nunca se aleja de la entrada.
  const stop = stopOnTick(side, price, targetDistance, info.tickSize)
  if (!stop) return blocked('stop_too_small_for_cost')
  const { stopPrice, distanciaStop } = stop

  // Los multiplicadores viven en (0, 1]: así un stop tocado pierde como máximo
  // riskPerTrade del capital base. Se recortan por si llega un valor fuera de rango.
  const multipliers = clampMultipliers(input.multipliers)
  const riesgoUsd = capitalBase * risk.riskPerTrade * multipliers.confidence * multipliers.symbol * multipliers.btc

  const initialLeverage = clamp(Math.floor(1 / (LIQUIDATION_STOP_MULTIPLE * targetDistance + info.mmr)), 1, risk.maxLeverage)
  const leverage = safeLeverage(side, price, stopPrice, initialLeverage, info.mmr)
  if (leverage === null) return blocked('liquidation_too_close')

  // El tamaño sale del stop buscado (spec §5.5); como el stop redondeado queda igual
  // o más cerca, el riesgo real nunca supera al presupuesto.
  let targetNotional = riesgoUsd / targetDistance
  const marginCap = capitalBase * risk.maxMarginPerTrade
  // El tope de margen reduce el nocional y conserva el apalancamiento.
  if (targetNotional / leverage > marginCap) targetNotional = marginCap * leverage

  const size = roundToContract(targetNotional, price, info)
  if (!size) return blocked('below_min_notional')
  const riesgoReal = size.notional * distanciaStop
  if (riesgoReal > RISK_ROUNDING_TOLERANCE * riesgoUsd) return blocked('risk_rounding')

  const margin = size.notional / leverage
  if (margin > capitalOperable + EPSILON) return blocked('insufficient_capital')

  const takeProfitPrice = targetOnTick(side, price, exits.tpR * distanciaStop, info.tickSize)

  return {
    ok: true,
    plan: {
      side,
      price,
      distanciaStop,
      riesgoUsd,
      riesgoReal,
      leverage,
      margin,
      notional: size.notional,
      qty: size.qty,
      stopPrice,
      takeProfitPrice,
      liquidationPrice: liquidationPrice(side, price, leverage, info.mmr),
      multipliers,
      theta,
    },
  }
}

// Modo "yo fijo tamaño y salidas" (spec §5.5): margen y apalancamiento fijos,
// SL/TP en porcentaje del precio. No aplican los topes del modo auto; sí los
// mínimos del contrato, el capital operable y que el SL quede antes de la liquidación.
export function planCustomEntry(input: CustomEntryInput): PlanResult {
  const { side, price, info, capitalBase, capitalOperable, theta } = input
  const { custom } = input.settings
  if (!isPositive(price)) return blocked('no_candle')
  if (!contractUsable(info)) return blocked('degraded')

  const { marginPerTrade, leverage } = custom
  const targetMargin = marginPerTrade.kind === 'usd' ? marginPerTrade.value : marginPerTrade.value * capitalBase
  if (!isPositive(targetMargin)) return blocked('insufficient_capital')

  const size = roundToContract(targetMargin * leverage, price, info)
  if (!size) return blocked('below_min_notional')
  const margin = size.notional / leverage
  if (margin > capitalOperable + EPSILON) return blocked('insufficient_capital')

  const stop = stopOnTick(side, price, custom.slPct, info.tickSize)
  if (!stop) return blocked('stop_too_small_for_cost')
  const { stopPrice, distanciaStop } = stop
  const takeProfitPrice = targetOnTick(side, price, custom.tpPct, info.tickSize)
  const liq = liquidationPrice(side, price, leverage, info.mmr)
  if (!liquidationFarEnough({ side, entry: price, stopPrice, liquidationPrice: liq }, 1)) return blocked('liquidation_too_close')

  // Sin riesgo objetivo en este modo: el riesgo "buscado" es el que fija el SL,
  // así R y el aprendizaje quedan definidos igual que en auto.
  const riesgoReal = size.notional * distanciaStop

  return {
    ok: true,
    plan: {
      side,
      price,
      distanciaStop,
      riesgoUsd: riesgoReal,
      riesgoReal,
      leverage,
      margin,
      notional: size.notional,
      qty: size.qty,
      stopPrice,
      takeProfitPrice,
      liquidationPrice: liq,
      multipliers: { ...NO_MULTIPLIERS },
      theta,
    },
  }
}

// Spec §5.5 calcula L con la fórmula del long; para el short la liquidación queda un
// poco más cerca ((1/L − mmr)/(1 + mmr)), así que en el borde se baja L de a un escalón
// hasta que el invariante se cumpla. Sin L válido (ni con 1x) no se abre.
function safeLeverage(side: Side, price: number, stopPrice: number, initial: number, mmr: number): number | null {
  for (let leverage = initial; leverage >= 1; leverage--) {
    const liq = liquidationPrice(side, price, leverage, mmr)
    if (liquidationFarEnough({ side, entry: price, stopPrice, liquidationPrice: liq })) return leverage
  }
  return null
}

// Stop en la grilla de `tickSize`, redondeado hacia la entrada: nunca se aleja, así que
// el riesgo no crece. `distanciaStop` se recalcula con el stop ya redondeado; si el
// redondeo lo deja sobre la entrada (o del otro lado) no hay stop posible.
function stopOnTick(side: Side, price: number, distance: number, tickSize: number): { stopPrice: number; distanciaStop: number } | null {
  const raw = priceAt(side, price, -distance)
  const stopPrice = side === 'long' ? ceilToStep(raw, tickSize) : floorToStep(raw, tickSize)
  const adverse = side === 'long' ? price - stopPrice : stopPrice - price
  if (!(adverse > 0)) return null
  return { stopPrice, distanciaStop: adverse / price }
}

// Objetivo a favor en la grilla de `tickSize`, redondeado hacia la entrada (queda apenas más cerca).
function targetOnTick(side: Side, price: number, distance: number, tickSize: number): number {
  const raw = priceAt(side, price, distance)
  return side === 'long' ? floorToStep(raw, tickSize) : ceilToStep(raw, tickSize)
}

// Sin un mmr en (0, 1) la liquidación no está definida y sin tick no hay precios
// válidos: es un dato del contrato roto, no una decisión de riesgo.
function contractUsable(info: SymbolInfo): boolean {
  return isPositive(info.mmr) && info.mmr < 1 && isPositive(info.tickSize)
}

// Redondea hacia abajo al múltiplo de `step`, devolviendo un número con los
// decimales del step (sin residuos de coma flotante).
export function floorToStep(value: number, step: number): number {
  return toStep(value, step, Math.floor)
}

// Igual que `floorToStep`, hacia arriba.
export function ceilToStep(value: number, step: number): number {
  return toStep(value, step, Math.ceil)
}

// Tolerancia relativa para reconocer un múltiplo exacto que la coma flotante corrió
// apenas (0.3 / 0.1 = 2.999…, 98.72 / 0.01 = 9872.000…01): se lo toma como exacto
// en vez de perder o ganar un step entero. El error de la división es del orden de
// 1e-16 relativo; 1e-12 deja un margen de miles de ulps sin redondear al más cercano
// cantidades reales (cientos de millones de unidades en monedas de ~1e-6 dólares).
const STEP_SNAP = 1e-12

function toStep(value: number, step: number, round: (units: number) => number): number {
  const units = value / step
  const nearest = Math.round(units)
  const snapped = Math.abs(units - nearest) <= STEP_SNAP * Math.max(1, Math.abs(units)) ? nearest : round(units)
  return Number((snapped * step).toFixed(decimalsOf(step)))
}

function decimalsOf(step: number): number {
  const [mantissa = '', exponent = '0'] = step.toString().split('e')
  const fraction = mantissa.split('.')[1]?.length ?? 0
  return Math.max(0, fraction - Number(exponent))
}

function roundToContract(targetNotional: number, price: number, info: SymbolInfo): { qty: number; notional: number } | null {
  const qty = floorToStep(targetNotional / price, info.stepSize)
  const notional = qty * price
  if (qty < info.minQty || notional < info.minNotional) return null
  return { qty, notional }
}

// Precio a una distancia (fracción del precio) en la dirección de la posición:
// positiva a favor, negativa en contra.
function priceAt(side: Side, price: number, distance: number): number {
  return side === 'long' ? price * (1 + distance) : price * (1 - distance)
}

function clampMultipliers(m: Multipliers): Multipliers {
  return { confidence: clamp(m.confidence, 0, 1), symbol: clamp(m.symbol, 0, 1), btc: clamp(m.btc, 0, 1) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function blocked(reason: BlockReason): PlanResult {
  return { ok: false, reason }
}
