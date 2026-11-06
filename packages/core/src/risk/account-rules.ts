import type { Settings } from '@sereno/shared'
import type { BlockReason, EntryPlan, Position, Side } from '../types'
import { EPSILON } from './epsilon'

export interface CapacityInput {
  open: Position[]
  side: Side
  plan: EntryPlan
  capitalBase: number
  capitalOperable: number
  settings: Pick<Settings, 'risk' | 'custom'>
  mode: 'auto' | 'custom'
}

// Reglas de capacidad de spec §5.4 sobre `capitalBase`. En auto aplican todas;
// en custom sólo posiciones máximas (las del modo), concentración por dirección
// y capital operable (spec §5.5, último párrafo).
export function checkCapacity(input: CapacityInput): BlockReason | null {
  const { open, side, plan, capitalBase, capitalOperable, mode } = input
  const { risk, custom } = input.settings

  const maxPositions = mode === 'auto' ? risk.maxPositions : custom.maxPositions
  if (open.length >= maxPositions) return 'max_positions'

  const sameDirection = open.filter((p) => p.side === side).length
  if (sameDirection >= risk.maxSameDirection) return 'max_same_direction'

  if (mode === 'auto') {
    const marginInUse = sum(open, (p) => p.margin)
    if (marginInUse + plan.margin > risk.maxMarginInUse * capitalBase + EPSILON) return 'max_margin'
    const notionalInUse = sum(open, (p) => p.notional)
    if (notionalInUse + plan.notional > risk.maxNotionalMultiple * capitalBase + EPSILON) return 'max_notional'
  }

  if (plan.margin > capitalOperable + EPSILON) return 'insufficient_capital'
  return null
}

export interface AccountRulesInput {
  capitalBase: number
  todayRealized: number
  equityPeak: number
  equity: number
  consecutiveStops: number
  stopsLastHour: number
  now: number
  settings: Pick<Settings, 'risk' | 'entry'>
}

export interface AccountRulesResult {
  blocked: BlockReason | null
  flags: {
    dailyLossHit: boolean
    drawdownPause: boolean
    // Hasta cuándo pausar por racha de stops (`now + streakPauseHours`), o null.
    streakPauseUntil: number | null
    // Hasta cuándo dura el enfriamiento global por stops en la última hora, o null.
    globalCooldownUntil: number | null
  }
}

const HOUR_MS = 3_600_000
const CANDLE_15M_MS = 15 * 60_000

// Cortes a nivel cuenta (spec §7) y enfriamiento global (spec §5.4). Es pura: dice
// qué reglas se cumplen con el estado que recibe; el motor decide cuándo empieza
// cada pausa (guarda el `until`, reinicia el contador de racha) y emite el evento.
// Si varias se cumplen, `blocked` informa la más grave: el drawdown pausa el bot
// hasta que Toti lo reanude, la pérdida diaria dura hasta el día siguiente, la
// racha unas horas y el enfriamiento unas velas.
export function accountRules(input: AccountRulesInput): AccountRulesResult {
  const { capitalBase, todayRealized, equityPeak, equity, consecutiveStops, stopsLastHour, now } = input
  const { risk, entry } = input.settings

  const dailyLossHit = capitalBase > 0 && todayRealized <= -(risk.dailyLossLimit * capitalBase)
  const drawdownPause = equityPeak > 0 && (equityPeak - equity) / equityPeak >= risk.maxDrawdown
  const streakPauseUntil = consecutiveStops >= risk.maxConsecutiveStops ? now + risk.streakPauseHours * HOUR_MS : null
  const globalCooldownUntil = stopsLastHour >= entry.globalCooldownStopsPerHour ? now + entry.globalCooldownCandles * CANDLE_15M_MS : null

  let blocked: BlockReason | null = null
  if (drawdownPause) blocked = 'drawdown_pause'
  else if (dailyLossHit) blocked = 'daily_loss'
  else if (streakPauseUntil !== null) blocked = 'streak_pause'
  else if (globalCooldownUntil !== null) blocked = 'global_cooldown'

  return { blocked, flags: { dailyLossHit, drawdownPause, streakPauseUntil, globalCooldownUntil } }
}

function sum(items: Position[], pick: (p: Position) => number): number {
  return items.reduce((acc, p) => acc + pick(p), 0)
}
