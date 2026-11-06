// Latido del proceso (spec §10 y §12): la fila de `bot_status` que el bot reescribe cada
// 10 s junto con el lease. Lleva la fase, los ajustes aplicados, los cortes activos y los
// errores recientes, para que el dashboard los diga sin recalcular nada.

import type { BtcContext } from '@sereno/core'
import type { EngineSnapshot } from '@sereno/core/src/engine/types'
import { isLearningFrozen } from '@sereno/core/src/learning/state'
import { btcVolatilityMultiplier } from '@sereno/core/src/signals/modifiers'
import type { BotError, BotFlags, HeartbeatInput } from '@sereno/db'
import { startOfDayBA, type BotPhase, type RealGate, type Settings } from '@sereno/shared'
import pkg from '../../package.json'

export const BOT_VERSION: string = pkg.version
const RECENT_ERRORS = 20

export interface StatusView {
  phase: BotPhase
  warmProgress: number
  universeSize: number
  lastCycleAt: number | null
  settingsVersionApplied: number | null
  degradedSymbols: string[]
  flags: BotFlags
  // Sólo la sesión real: si puede abrir, sólo cuidar o nada, y qué le falta.
  real?: RealGate
}

export const NO_FLAGS: BotFlags = { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false }

export function heartbeatInput(sessionId: string, instanceId: string, view: StatusView, recentErrors: readonly BotError[]): HeartbeatInput {
  return {
    sessionId,
    instanceId,
    phase: view.phase,
    warmProgress: view.warmProgress,
    universeSize: view.universeSize,
    lastCycleAt: view.lastCycleAt === null ? null : new Date(view.lastCycleAt),
    settingsVersionApplied: view.settingsVersionApplied,
    degradedSymbols: view.degradedSymbols,
    flags: view.flags,
    recentErrors: [...recentErrors],
    botVersion: BOT_VERSION,
    real: view.real ?? null,
  }
}

// Los cortes de lo real tal como están ahora; el de volatilidad, el del último ciclo.
export function flagsOf(snapshot: EngineSnapshot, settings: Settings, btc: BtcContext | null, now: number): BotFlags {
  const guard = snapshot.real.guard
  return {
    btcVolExtreme: btc !== null && btcVolatilityMultiplier(btc) < 1,
    dailyLossHit: guard.dailyLossNotified && guard.dayStart === startOfDayBA(now),
    drawdownPause: guard.drawdownPaused,
    streakPause: guard.streakPauseUntil !== null && guard.streakPauseUntil > now,
    learningFrozen: isLearningFrozen(snapshot.learning, settings.learning),
  }
}

// Los últimos errores, el más reciente al final.
export class RecentErrors {
  private items: BotError[] = []

  push(at: number, message: string, context?: string): void {
    this.items = [...this.items, { at: new Date(at).toISOString(), message, ...(context === undefined ? {} : { context }) }].slice(-RECENT_ERRORS)
  }

  list(): BotError[] {
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }
}
