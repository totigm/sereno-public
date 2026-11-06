import type { Settings } from '@sereno/shared'
import { learningUpdated } from '../engine/events'
import { applyReliability, reliability, type DecisionSample } from '../learning/reliability'
import { isLearningFrozen } from '../learning/state'
import type { Decision, EngineEvent, SignalResult } from '../types'
import { CANDLE_MS, DAY_MS } from './clock'
import type { Lane } from './lane'
import type { ReplayMarket } from './market'

// La fiabilidad semanal de las señales dentro de un replay (spec §8.1, segunda vía): lo que
// el job del bot hace los domingos a las 00:30 UTC con las decisiones guardadas y su retorno
// a 4 h, acá con las decisiones que el replay ya tomó y las velas que ya recorrió.

// Decisiones de los últimos 28 días, de todas las monedas.
export const RELIABILITY_WINDOW_MS = 28 * DAY_MS
// El retorno a 4 h es el cierre 16 velas de 15m después de la vela que decidió.
export const FORWARD_RETURN_CANDLES = 16

interface Kept {
  symbol: string
  t: number
  signals: SignalResult[]
}

// Precio de cierre de la vela de 15m que abre en `openTime`, o null si no hay.
export type CloseAt = (symbol: string, openTime: number) => number | null

export class ReliabilityWindow {
  private kept: Kept[] = []

  // De cada decisión sólo hacen falta la moneda, el instante y lo que votó cada señal.
  add(decision: Decision): void {
    this.kept.push({ symbol: decision.symbol, t: decision.t, signals: decision.composite.signals.map(({ id, value }) => ({ id, value })) })
  }

  // Las decisiones en [now − 28 días, now) cuyo retorno a 4 h ya se conoce en `now`
  // (sólo velas cerradas hasta ahí). Olvida las anteriores a la ventana.
  samples(now: number, closeAt: CloseAt): DecisionSample[] {
    const since = now - RELIABILITY_WINDOW_MS
    this.kept = this.kept.filter((k) => k.t >= since)
    const out: DecisionSample[] = []
    for (const { symbol, t, signals } of this.kept) {
      if (t + FORWARD_RETURN_CANDLES * CANDLE_MS > now) continue
      const base = closeAt(symbol, t - CANDLE_MS)
      const later = closeAt(symbol, t + (FORWARD_RETURN_CANDLES - 1) * CANDLE_MS)
      if (base === null || later === null || !(base > 0) || !Number.isFinite(later)) continue
      out.push({ signals, forwardReturn4h: later / base - 1 })
    }
    return out
  }
}

export interface WeeklyReliability {
  market: ReplayMarket
  lane: Lane
  window: ReliabilityWindow
  settings: Settings
  emit: (event: EngineEvent) => void
}

export async function applyWeeklyReliability({ market, lane, window, settings, emit }: WeeklyReliability, now: number): Promise<void> {
  const learning = lane.engine.snapshot().learning
  if (isLearningFrozen(learning, settings.learning)) return
  const samples = window.samples(now, (symbol, openTime) => market.feed(symbol, openTime)?.last.close ?? null)
  const applied = applyReliability(learning, reliability(samples), settings.learning, now, { sampleSize: samples.length })
  if (applied.state !== learning) await lane.engine.applyLearning(applied.state)
  for (const change of applied.log) emit(learningUpdated(change))
}
