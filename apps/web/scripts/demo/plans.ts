import type { SymbolInfo } from '@sereno/core'
import { fillPrice } from '@sereno/core/src/exchange/fills'
import { roundTripCost } from '@sereno/core/src/risk/costs'
import { ceilToStep, floorToStep, planEntry } from '@sereno/core/src/risk/sizing'
import type { Settings } from '@sereno/shared'
import type { Coin } from './coins'
import type { Levels, RuleExit } from './exits'
import type { Anchor } from './path'
import type { ExitSpec, MarketReason, TradeSpec, Waypoint } from './spec'
import { CYCLE_SETTLE_MS, HOUR_MS } from './time'

// Un trade del escenario traducido a la grilla: niveles de precio (los mismos para
// las dos carteras, que comparten mercado y salidas por defecto), los anclajes que el
// camino tiene que respetar y la salida que las reglas tienen que dar.

// Antes de la vela de salida el precio queda a `NEAR_R` del nivel que va a cruzar (de
// su lado); esa vela cierra `CROSS_R` del otro lado.
const NEAR_R = 0.15
const CROSS_R = 0.1
// El trailing se mueve de a 0,1R: el cierre de salida pasa 0,3R el nivel esperado
// para cruzarlo aunque el stop haya quedado un escalón atrás.
export const TRAIL_CROSS_R = 0.3

export interface Leg {
  // Lo que `walkTrade` tiene que devolver: una salida por regla en esa vela, o
  // ninguna salida hasta `to` (exclusivo).
  expect: { reason: RuleExit; candle: number } | null
  to: number
  // Último punto que el trade necesita intacto.
  end: number
  market: { reason: MarketReason; index: number } | null
}

export interface TradePlan {
  spec: TradeSpec
  coin: Coin
  info: SymbolInfo
  openIndex: number
  // Último precio en el cierre de la vela de la decisión: el que llena la entrada.
  ref: number
  atr1h: number
  levels: Levels
  real: Leg
  shadow: Leg
  anchors: Anchor[]
}

export interface PlanContext {
  times: readonly number[]
  lastBoundary: number
  // Precio del camino ya decidido en un punto (un anclaje anterior) o de la base.
  priceAt: (index: number) => number
  settings: Pick<Settings, 'risk' | 'exits' | 'entry'>
}

// ATR de 1h típico de la moneda: la volatilidad diaria repartida en 24 horas, con un
// 20% más porque el rango de una vela supera a su retorno.
export function typicalAtrPct(coin: Coin, scale = 1): number {
  return (coin.dailyVol / Math.sqrt(24)) * 1.2 * scale
}

function indexOf(ctx: PlanContext, t: number): number {
  const step = (ctx.times[1] ?? 0) - (ctx.times[0] ?? 0)
  const index = (t - (ctx.times[0] ?? 0)) / step
  if (!Number.isInteger(index) || index < 0 || index > ctx.lastBoundary) {
    throw new RangeError(`${new Date(t).toISOString()} no es un cierre de vela dentro del escenario`)
  }
  return index
}

// Lo que decide un ciclo (entrar, salir a mercado o por tiempo) se ejecuta unos
// segundos después del cierre: tiene que haber terminado antes del final de la sesión.
function settledIndex(ctx: PlanContext, spec: TradeSpec, index: number, what: string): number {
  const t = ctx.times[index]
  const end = spec.until ?? ctx.times[ctx.times.length - 1] ?? 0
  if (t === undefined || index > ctx.lastBoundary || t + CYCLE_SETTLE_MS > end) {
    throw new RangeError(`El trade ${spec.id}: ${what} cae en un ciclo que no terminó de ejecutar antes del final de la sesión`)
  }
  return index
}

function entryPlan(spec: TradeSpec, info: SymbolInfo, ref: number, atr1h: number, ctx: PlanContext) {
  // Los niveles no dependen del capital: se piden con uno holgado.
  const result = planEntry({
    side: spec.side,
    price: ref,
    atr1h,
    info,
    capitalBase: 1e6,
    capitalOperable: 1e6,
    settings: ctx.settings,
    multipliers: { confidence: 1, symbol: 1, btc: 1 },
    theta: ctx.settings.entry.theta,
  })
  if (!result.ok) throw new Error(`El trade ${spec.id} (${spec.symbol}) no se puede abrir: ${result.reason}`)
  return result.plan
}

function entryFill(spec: TradeSpec, info: SymbolInfo, ref: number, ctx: PlanContext): number {
  const side = spec.side === 'long' ? 'buy' : 'sell'
  return fillPrice({ lastPrice: ref, halfSpreadRate: info.halfSpreadRate, slippageRate: ctx.settings.risk.slippageRate, notional: 0, side }).price
}

// Para una abierta el dato es el precio de ahora: la entrada se deduce para que el no
// realizado sea `r` (el stop redondeado al tick lo corre apenas).
function refForOpen(spec: TradeSpec, info: SymbolInfo, atrPct: number, endPrice: number, r: number, ctx: PlanContext): number {
  const s = spec.side === 'long' ? 1 : -1
  const floor = ctx.settings.exits.stopFloorCostMultiple * roundTripCost(info, ctx.settings.risk)
  const dRel = Math.max(ctx.settings.exits.k * atrPct, floor)
  const friction = info.halfSpreadRate + ctx.settings.risk.slippageRate
  return endPrice / (1 + s * friction + s * r * dRel)
}

export function planTrade(spec: TradeSpec, coin: Coin, info: SymbolInfo, ctx: PlanContext): TradePlan {
  const openIndex = settledIndex(ctx, spec, indexOf(ctx, spec.open), 'la entrada')
  const atrPct = typicalAtrPct(coin, spec.atrScale)
  // Donde se valúa una abierta: el final del mercado o el de su sesión.
  const lastIndex = spec.until === undefined ? ctx.times.length - 1 : indexOf(ctx, spec.until)
  const endPrice = ctx.priceAt(lastIndex)
  const ref = spec.exit.kind === 'open' ? refForOpen(spec, info, atrPct, endPrice, spec.exit.r, ctx) : ctx.priceAt(openIndex)
  const atr1h = ref * atrPct
  const plan = entryPlan(spec, info, ref, atr1h, ctx)
  const entry = entryFill(spec, info, ref, ctx)
  const levels: Levels = {
    side: spec.side,
    entry,
    dist: ref * plan.distanciaStop,
    stop: plan.stopPrice,
    tp: plan.takeProfitPrice,
    tick: info.tickSize,
  }
  const anchors: Anchor[] = [{ index: openIndex, price: ref }]
  // El final del mercado ya está anclado al precio de la tabla; el de una sesión que
  // termina antes, no: la abierta tiene que valer ahí lo que se calculó.
  if (spec.exit.kind === 'open' && spec.until !== undefined) anchors.push({ index: lastIndex, price: endPrice })
  const builder = { spec, ctx, levels, openIndex, lastIndex, anchors }
  const real = resolveLeg(builder, spec.exit, spec.waypoints ?? [])
  let shadow = real
  if (spec.shadowExit) {
    if (real.market === null) throw new Error(`El trade ${spec.id}: la sombra sólo se separa en un cierre a mercado`)
    shadow = resolveLeg(builder, spec.shadowExit, spec.shadowWaypoints ?? [])
  }
  return { spec, coin, info, openIndex, ref, atr1h, levels, real, shadow, anchors }
}

interface LegBuilder {
  spec: TradeSpec
  ctx: PlanContext
  levels: Levels
  openIndex: number
  lastIndex: number
  anchors: Anchor[]
}

function resolveLeg(b: LegBuilder, exit: ExitSpec, waypoints: readonly Waypoint[]): Leg {
  const { levels, spec, ctx } = b
  const s = levels.side === 'long' ? 1 : -1
  const at = (r: number): number => levels.entry + s * r * levels.dist
  const anchor = (index: number, price: number): void => {
    if (index <= b.openIndex) throw new RangeError(`El trade ${spec.id}: un punto queda antes de la entrada`)
    b.anchors.push({ index, price })
  }
  for (const w of waypoints) anchor(indexOf(ctx, w.at), at(w.r))

  // Salida por nivel en la vela que termina en `index`: el punto anterior queda cerca
  // del nivel, del lado de la entrada, y la vela cierra del otro lado.
  const crossing = (index: number, level: number, beyond: number, reason: RuleExit): Leg => {
    if (index - 1 <= b.openIndex) throw new RangeError(`El trade ${spec.id} necesita al menos dos velas`)
    const towardEntry = reason === 'take_profit' ? -s : s
    anchor(index - 1, level + towardEntry * NEAR_R * levels.dist)
    anchor(index, level - towardEntry * beyond * levels.dist)
    return { expect: { reason, candle: index - 1 }, to: index, end: index, market: null }
  }

  switch (exit.kind) {
    case 'stop':
      return crossing(indexOf(ctx, exit.at), levels.stop, CROSS_R, 'stop')
    case 'take_profit': {
      if (levels.tp === null) throw new Error(`El trade ${spec.id} no tiene take profit`)
      return crossing(indexOf(ctx, exit.at), levels.tp, CROSS_R, 'take_profit')
    }
    case 'trailing_stop': {
      const { trailingR, trailingActivationR, tpR } = ctx.settings.exits
      if (!(exit.peakR > trailingActivationR + 0.1 && exit.peakR < tpR - 0.1)) {
        throw new RangeError(`El trade ${spec.id}: el pico del trailing tiene que quedar entre la activación y el take profit`)
      }
      const peak = at(exit.peakR)
      anchor(indexOf(ctx, exit.peakAt), peak)
      const raw = peak - s * trailingR * levels.dist
      const trail = levels.side === 'long' ? Math.max(levels.entry, floorToStep(raw, levels.tick)) : Math.min(levels.entry, ceilToStep(raw, levels.tick))
      return crossing(indexOf(ctx, exit.at), trail, TRAIL_CROSS_R, 'trailing_stop')
    }
    case 'time_exit': {
      const { timeExitHours, timeExitMinR } = ctx.settings.exits
      if (exit.r > timeExitMinR) throw new RangeError(`El trade ${spec.id}: la salida por tiempo pide un no realizado ≤ ${timeExitMinR}R`)
      const step = (ctx.times[1] ?? 0) - (ctx.times[0] ?? 0)
      const index = settledIndex(ctx, spec, b.openIndex + (timeExitHours * HOUR_MS) / step, 'la salida por tiempo')
      anchor(index, at(exit.r))
      return { expect: { reason: 'time_exit', candle: index - 1 }, to: index, end: index, market: null }
    }
    case 'market': {
      const index = settledIndex(ctx, spec, indexOf(ctx, exit.at), 'la salida a mercado')
      anchor(index, at(exit.r))
      return { expect: null, to: index, end: index, market: { reason: exit.reason, index } }
    }
    case 'open':
      // En vivo recorre también la vela abierta; en un replay, hasta su final.
      return { expect: null, to: spec.until === undefined ? Number.POSITIVE_INFINITY : b.lastIndex, end: b.lastIndex, market: null }
  }
}
