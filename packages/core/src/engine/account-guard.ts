import { startOfDayBA, type Settings } from '@sereno/shared'
import type { AccountRuleData } from '../journal/phrases'
import { accountRules } from '../risk/account-rules'
import type { BlockReason, ClosedPosition, CloseReason } from '../types'

// Estado de los cortes de cuenta de una cartera (spec §5.4 y §7). `accountRules` dice
// qué regla se cumple con el estado que recibe; acá vive ese estado: lo realizado en el
// día, el pico de equity, la racha, los stops de la última hora, los `until` de cada
// pausa y los enfriamientos por moneda. Es serializable para que el runtime lo guarde.

export type GuardSettings = Pick<Settings, 'risk' | 'entry'>

// Qué hace el drawdown máximo al cumplirse. Lo real se pausa hasta que Toti reanude
// (spec §7). La sombra no tiene quién la reanude: una pausa suya duraría para siempre y
// la comparación con lo aprendido mediría a una cartera que dejó de operar; por eso
// avisa, vuelve a medir el pico desde ahí y sigue.
export type DrawdownBehavior = 'pause' | 'rebase'

export interface GuardOptions {
  drawdown: DrawdownBehavior
}

export interface GuardState {
  // 00:00 de Buenos Aires del día en curso: el día de la pérdida diaria es el de Toti.
  dayStart: number
  // Realizado desde `dayStart`: pnl de cierres, comisiones y funding.
  dayRealized: number
  dailyLossNotified: boolean
  // null mientras no hay equity confiable (al arrancar o al reanudar).
  equityPeak: number | null
  drawdownPaused: boolean
  consecutiveStops: number
  streakPauseUntil: number | null
  // Instantes de los stops todavía dentro de la última hora.
  stopTimes: number[]
  globalCooldownUntil: number | null
  cooldownUntil: Record<string, number>
  shieldShortfallNotified: boolean
  // La equity tocó el piso del tope de pérdida: la cartera no abre nunca más. Opcional
  // para que los estados guardados antes de que existiera sigan valiendo.
  lossFloorHit?: true
}

export type GuardTrigger =
  | { rule: 'daily_loss'; data: AccountRuleData['daily_loss'] }
  | { rule: 'drawdown'; data: AccountRuleData['drawdown'] }
  | { rule: 'streak'; data: AccountRuleData['streak'] }

export interface GuardInput {
  now: number
  capitalBase: number
  // null si a alguna abierta le falta la marca: el equity no es confiable.
  equity: number | null
  settings: GuardSettings
}

export interface GuardResult {
  blocked: BlockReason | null
  // Reglas que se dispararon en esta evaluación (cada una avisa una sola vez).
  triggers: GuardTrigger[]
}

const HOUR_MS = 3_600_000
const CANDLE_15M_MS = 15 * 60_000

// Stops que cuentan para la racha y para el enfriamiento global: los que cortan pérdida.
const STOP_LOSSES: ReadonlySet<CloseReason> = new Set(['stop', 'liquidation', 'stop_missed_offline'])
// Salidas de la estrategia que cortan la racha. Los cierres pedidos (manual, cerrar
// todo, blindaje, deslistado, archivo) no son resultados de la estrategia: no la tocan.
const STRATEGY_EXITS: ReadonlySet<CloseReason> = new Set(['take_profit', 'trailing_stop', 'signal_flip', 'time_exit'])

export function initialGuardState(now: number): GuardState {
  return {
    dayStart: startOfDayBA(now),
    dayRealized: 0,
    dailyLossNotified: false,
    equityPeak: null,
    drawdownPaused: false,
    consecutiveStops: 0,
    streakPauseUntil: null,
    stopTimes: [],
    globalCooldownUntil: null,
    cooldownUntil: {},
    shieldShortfallNotified: false,
  }
}

export class AccountGuard {
  private state: GuardState
  private readonly drawdown: DrawdownBehavior

  constructor(state: GuardState, options: GuardOptions = { drawdown: 'pause' }) {
    this.state = structuredClone(state)
    this.drawdown = options.drawdown
  }

  snapshot(): GuardState {
    return structuredClone(this.state)
  }

  noteRealized(amount: number, at: number): void {
    this.rollDay(at)
    this.state.dayRealized += amount
  }

  noteClose(closed: ClosedPosition, entry: Settings['entry']): void {
    const s = this.state
    if (STOP_LOSSES.has(closed.closeReason)) {
      s.consecutiveStops += 1
      s.stopTimes.push(closed.closedAt)
    } else if (STRATEGY_EXITS.has(closed.closeReason)) {
      s.consecutiveStops = 0
    }
    if (closed.pnlNet < 0 && entry.cooldownCandlesAfterLoss > 0) {
      s.cooldownUntil[closed.symbol] = closed.closedAt + entry.cooldownCandlesAfterLoss * CANDLE_15M_MS
    }
  }

  inCooldown(symbol: string, now: number): boolean {
    const until = this.state.cooldownUntil[symbol]
    return until !== undefined && until > now
  }

  // Aplica las reglas con el estado actual: las que se cumplen por primera vez abren su
  // pausa (guardando el `until` y reiniciando su contador) y se informan una sola vez.
  evaluate(input: GuardInput): GuardResult {
    const { now, capitalBase, equity, settings } = input
    const s = this.state
    this.rollDay(now)
    s.stopTimes = s.stopTimes.filter((at) => at > now - HOUR_MS)
    for (const [symbol, until] of Object.entries(s.cooldownUntil)) if (until <= now) delete s.cooldownUntil[symbol]
    if (equity !== null) s.equityPeak = Math.max(s.equityPeak ?? equity, equity)

    // Sin equity confiable el drawdown no se mide (pico 0 = regla apagada).
    const peak = equity === null ? 0 : (s.equityPeak ?? 0)
    const { flags } = accountRules({
      capitalBase,
      todayRealized: s.dayRealized,
      equityPeak: peak,
      equity: equity ?? 0,
      consecutiveStops: s.consecutiveStops,
      stopsLastHour: s.stopTimes.length,
      now,
      settings,
    })

    const triggers: GuardTrigger[] = []
    if (flags.drawdownPause && !s.drawdownPaused && equity !== null) {
      triggers.push({ rule: 'drawdown', data: { peak, equity } })
      if (this.drawdown === 'pause') s.drawdownPaused = true
      else s.equityPeak = equity
    }
    if (flags.dailyLossHit && !s.dailyLossNotified) {
      s.dailyLossNotified = true
      triggers.push({ rule: 'daily_loss', data: { todayRealized: s.dayRealized, limitPct: settings.risk.dailyLossLimit } })
    }
    if (flags.streakPauseUntil !== null) {
      triggers.push({ rule: 'streak', data: { stops: s.consecutiveStops, until: flags.streakPauseUntil } })
      s.streakPauseUntil = flags.streakPauseUntil
      s.consecutiveStops = 0
    }
    // Los stops que abren el enfriamiento global no lo vuelven a abrir cuando termina.
    if (flags.globalCooldownUntil !== null) {
      s.globalCooldownUntil = flags.globalCooldownUntil
      s.stopTimes = []
    }
    return { blocked: this.blockedAt(now, flags.dailyLossHit, settings), triggers }
  }

  // Toti reanudó: termina la pausa por drawdown y el pico se vuelve a medir desde acá
  // (si no, el mismo drawdown la volvería a disparar en el ciclo siguiente). Reanudar
  // de cualquier otra pausa no toca el pico: borrarlo aflojaría el corte del 15%.
  resume(): void {
    if (!this.state.drawdownPaused) return
    this.state.drawdownPaused = false
    this.state.equityPeak = null
  }

  // Pone el pestillo del tope de pérdida: true sólo la primera vez.
  noteLossFloor(): boolean {
    if (this.state.lossFloorHit) return false
    this.state.lossFloorHit = true
    return true
  }

  lossFloorHit(): boolean {
    return this.state.lossFloorHit === true
  }

  // Lleva el aviso de "capital blindado sin ganancia para operar": true sólo cuando la
  // condición empieza; vuelve a avisar si se resolvió y reaparece.
  noteShieldShortfall(active: boolean): boolean {
    const started = active && !this.state.shieldShortfallNotified
    this.state.shieldShortfallNotified = active
    return started
  }

  // La más grave primero, como `accountRules`: el tope de pérdida no se levanta nunca, el
  // drawdown espera a Toti, la pérdida diaria al día siguiente, la racha unas horas y el
  // enfriamiento global unas velas.
  private blockedAt(now: number, dailyLossHit: boolean, settings: GuardSettings): BlockReason | null {
    const s = this.state
    if (s.lossFloorHit) return 'loss_floor'
    if (s.drawdownPaused) return 'drawdown_pause'
    if (dailyLossHit) return 'daily_loss'
    if (s.streakPauseUntil !== null && s.streakPauseUntil > now) return 'streak_pause'
    if (s.globalCooldownUntil !== null && s.globalCooldownUntil > now) return globalCooldownReason(settings)
    return null
  }

  private rollDay(at: number): void {
    const start = startOfDayBA(at)
    if (start <= this.state.dayStart) return
    this.state.dayStart = start
    this.state.dayRealized = 0
    this.state.dailyLossNotified = false
  }
}

// El motivo con que `accountRules` informa el enfriamiento global: se le pregunta con
// sólo esa regla cumplida en vez de repetir el nombre acá, que es de risk/account-rules.
function globalCooldownReason(settings: GuardSettings): BlockReason {
  const { blocked } = accountRules({
    capitalBase: 0,
    todayRealized: 0,
    equityPeak: 0,
    equity: 0,
    consecutiveStops: 0,
    stopsLastHour: settings.entry.globalCooldownStopsPerHour,
    now: 0,
    settings,
  })
  if (blocked === null) throw new Error('accountRules no informó el enfriamiento global')
  return blocked
}
