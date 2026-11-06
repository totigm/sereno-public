import type { Settings } from '@sereno/shared'
import { direction } from '../exchange/sides'
import { ceilToStep, floorToStep } from '../risk/sizing'
import type { CloseReason, Position } from '../types'

// Reglas de salida de una posición abierta (spec §5.6), como funciones puras: las usa
// el motor con cada tick y cada ciclo, y el replay con cada vela. Todo se mide en R
// de la posición: 1R = distanciaStop × entrada, en precio.

const HOUR_MS = 3_600_000
// Los R salen de divisiones: llegar "justo" a +1R no puede quedar 1e-16 por debajo.
const R_TOLERANCE = 1e-9

export interface TrailingRule {
  // R a favor (con el mejor precio de marca) desde el que el stop sigue al precio.
  activationR: number
  // Distancia del stop al mejor precio, en R.
  distanceR: number
  // Grilla de precios del contrato: el stop nuevo tiene que ser un precio válido.
  tickSize: number
}

export interface ExitRules {
  trailing: TrailingRule | null
  time: { hours: number; minR: number } | null
  signal: { fraction: number } | null
}

// Las reglas dependen del modo con que se abrió la posición: cambiar de modo afecta a
// las nuevas, no a las abiertas (spec §7). En custom no hay salida por señal ni por
// tiempo, y el trailing opcional en % se comporta como el de auto: al avanzar ese %
// el stop pasa a la entrada y después sigue a ese % del mejor precio.
export function exitRulesFor(p: Position, settings: Pick<Settings, 'exits' | 'custom'>, tickSize: number): ExitRules {
  if (p.mode === 'custom') {
    const pct = settings.custom.trailingPct
    const trailing = pct === null ? null : { activationR: pct / p.distanciaStop, distanceR: pct / p.distanciaStop, tickSize }
    return { trailing, time: null, signal: null }
  }
  const { exits } = settings
  return {
    trailing: { activationR: exits.trailingActivationR, distanceR: exits.trailingR, tickSize },
    time: { hours: exits.timeExitHours, minR: exits.timeExitMinR },
    signal: { fraction: exits.signalExitFraction },
  }
}

// Stop nuevo por trailing con esta marca, o null si no se mueve. Al activarse el stop
// no queda peor que la entrada; después sigue a `distanceR` del mejor precio. Se
// redondea al tick hacia la marca (nunca queda más lejos de lo que pide la regla),
// nunca retrocede y queda del lado seguro de la marca: una orden ya cruzada se rechaza.
export function nextStop(p: Position, mark: number, exits: ExitRules): number | null {
  const rule = exits.trailing
  const oneR = p.distanciaStop * p.entryPrice
  if (rule === null || !(mark > 0) || !(oneR > 0)) return null
  const dir = direction(p.side)
  const best = dir === 1 ? Math.max(p.bestPrice, mark) : Math.min(p.bestPrice, mark)
  if ((dir * (best - p.entryPrice)) / oneR < rule.activationR - R_TOLERANCE) return null

  const trailed = best - dir * rule.distanceR * oneR
  const target = dir === 1 ? Math.max(trailed, p.entryPrice) : Math.min(trailed, p.entryPrice)
  const stop = dir === 1 ? ceilToStep(target, rule.tickSize) : floorToStep(target, rule.tickSize)
  if (dir * (stop - p.stopPrice) <= 0 || dir * (mark - stop) <= 0) return null
  return stop
}

// Salida por tiempo: pasadas las horas, si el no realizado no supera el mínimo en R.
export function shouldTimeExit(p: Position, now: number, unrealized: number, exits: ExitRules): boolean {
  const rule = exits.time
  if (rule === null) return false
  return now - p.openedAt >= rule.hours * HOUR_MS && unrealized <= rule.minR
}

// Salida por señal: S′ del otro lado, al menos a `fraction` del θ con que se abrió.
export function shouldSignalExit(p: Position, Sprime: number, exits: ExitRules): boolean {
  const rule = exits.signal
  if (rule === null) return false
  const limit = p.thetaAtOpen * rule.fraction
  return p.side === 'long' ? Sprime <= -limit : Sprime >= limit
}

// R no realizado bruto a la marca ("el no realizado del momento"): sin comisiones ni funding.
export function unrealizedR(p: Position, mark: number): number {
  if (!(p.riesgoReal > 0)) return 0
  return (direction(p.side) * (mark - p.entryPrice) * p.qty) / p.riesgoReal
}

// Qué salida cruzó la marca, con el mismo criterio inclusivo con que dispara el exchange.
// Es el respaldo del motor cuando una orden no estaba (o el exchange no la disparó).
export function crossedExit(p: Position, mark: number): 'stop' | 'take_profit' | null {
  const dir = direction(p.side)
  if (dir * (mark - p.stopPrice) <= 0) return 'stop'
  if (p.takeProfitPrice !== null && dir * (mark - p.takeProfitPrice) >= 0) return 'take_profit'
  return null
}

// Un stop que el trailing ya movió es un trailing stop.
export function stopCloseReason(p: Position): Extract<CloseReason, 'stop' | 'trailing_stop'> {
  return p.trailingActive ? 'trailing_stop' : 'stop'
}
