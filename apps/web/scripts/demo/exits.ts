import type { Candle, Side } from '@sereno/core'
import { ceilToStep, floorToStep } from '@sereno/core/src/risk/sizing'
import type { Settings } from '@sereno/shared'
import { HOUR_MS } from './time'

// Las salidas automáticas de spec §5.6 recorridas vela a vela con el orden canónico
// del replay (§6): primero el extremo adverso (stop), después el favorable (take
// profit, trailing). El marcado es el último precio: en la demostración la marca y
// el último coinciden. Sirve para comprobar que el camino inventado de cada trade
// produce exactamente la salida que el escenario pidió.

export interface Levels {
  side: Side
  // Precio de entrada (el fill) y distancia del stop en precio: 1R.
  entry: number
  dist: number
  stop: number
  tp: number | null
  tick: number
}

export type ExitRules = Pick<Settings['exits'], 'trailingR' | 'trailingActivationR' | 'timeExitHours' | 'timeExitMinR'>

export type RuleExit = 'stop' | 'take_profit' | 'trailing_stop' | 'time_exit'

export interface StopMove {
  candle: number
  from: number
  to: number
}

export interface Walk {
  exit: { reason: RuleExit; candle: number; price: number } | null
  moves: StopMove[]
  best: number
  trailingActive: boolean
  stop: number
}

// Mover el trailing de a centavos llenaría el diario de eventos: sólo se mueve
// cuando mejora al menos 0,1R.
export const TRAILING_MIN_MOVE_R = 0.1

export function walkTrade(levels: Levels, rules: ExitRules, candles: readonly Candle[], from: number, to: number, openBoundary: number): Walk {
  const long = levels.side === 'long'
  const dir = long ? 1 : -1
  let stop = levels.stop
  let best = levels.entry
  let trailingActive = false
  const moves: StopMove[] = []
  const done = (exit: Walk['exit']): Walk => ({ exit, moves, best, trailingActive, stop })

  for (let i = from; i < to; i++) {
    const c = candles[i]
    if (!c) break
    const adverse = long ? c.low : c.high
    if (dir * (adverse - stop) <= 0) return done({ reason: trailingActive ? 'trailing_stop' : 'stop', candle: i, price: stop })
    const favorable = long ? c.high : c.low
    if (levels.tp !== null && dir * (favorable - levels.tp) >= 0) return done({ reason: 'take_profit', candle: i, price: levels.tp })

    if (dir * (favorable - best) > 0) best = favorable
    const gainR = (dir * (best - levels.entry)) / levels.dist
    if (gainR >= rules.trailingActivationR) {
      const raw = best - dir * rules.trailingR * levels.dist
      const trail = long ? floorToStep(raw, levels.tick) : ceilToStep(raw, levels.tick)
      // Al activarse el stop va a la entrada; desde ahí sigue al mejor precio.
      const target = long ? Math.max(levels.entry, trail) : Math.min(levels.entry, trail)
      const improves = !trailingActive || dir * (target - stop) >= TRAILING_MIN_MOVE_R * levels.dist
      if (improves && target !== stop) {
        moves.push({ candle: i, from: stop, to: target })
        stop = target
      }
      trailingActive = true
    }

    const elapsedHours = (c.closeTime + 1 - openBoundary) / HOUR_MS
    if (c.closed && elapsedHours >= rules.timeExitHours) {
      const unrealizedR = (dir * (c.close - levels.entry)) / levels.dist
      if (unrealizedR <= rules.timeExitMinR) return done({ reason: 'time_exit', candle: i, price: c.close })
    }
  }
  return done(null)
}
