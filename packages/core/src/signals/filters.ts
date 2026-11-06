// Filtros booleanos de entrada (spec §5.3c y §5.4), sin la capacidad de la cuenta (risk/sizing).
// Devuelve el primer motivo de bloqueo o null. Orden: primero el estado del símbolo (dato
// vigente, degradado, posición, enfriamiento, penitencia), después la dirección permitida y
// al final el mercado (tendencia mayor, volumen), para que el diario diga la causa más concreta.
import type { BlockReason, Composite, MarketView, Side } from '../types'

export type EntryDirection = 'both' | Side

export interface EntryContext {
  hasPosition: boolean
  inCooldown: boolean
  inPenalty: boolean
  degraded: boolean
  // Restricción de dirección del modo custom (`settings.custom.direction`); 'both' en auto.
  direction: EntryDirection
  // `settings.entry.minRelVolume`; por defecto el 0,8 de la spec.
  minRelVolume?: number
}

export const DEFAULT_MIN_REL_VOLUME = 0.8
const CANDLE_15M_MS = 15 * 60_000

// La vela de decisión es la de 15m que cerró en t: su closeTime cae en los 15 minutos previos
// a t. Si la última vela es más vieja, la vela de t faltó o llegó tarde (spec §5.2).
function hasDecisionCandle(view: MarketView): boolean {
  const last = view.candles['15m'].at(-1)
  return last !== undefined && last.closeTime > view.t - CANDLE_15M_MS
}

function directionAllowed(S: number, direction: EntryDirection): boolean {
  if (direction === 'both' || S === 0) return true
  return direction === 'long' ? S > 0 : S < 0
}

export function entryFilters(view: MarketView, composite: Composite, ctx: EntryContext): BlockReason | null {
  if (!hasDecisionCandle(view)) return 'no_candle'
  if (ctx.degraded) return 'degraded'
  if (ctx.hasPosition) return 'has_position'
  if (ctx.inCooldown) return 'cooldown'
  if (ctx.inPenalty) return 'penalty'
  if (!directionAllowed(composite.S, ctx.direction)) return 'direction_not_allowed'
  if (composite.higherTrendAgainst === 2) return 'higher_trend_against'
  if (composite.relVolume < (ctx.minRelVolume ?? DEFAULT_MIN_REL_VOLUME)) return 'low_volume'
  return null
}
