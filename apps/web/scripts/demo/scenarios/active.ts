import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { LiveSpec } from '../live'
import type { ForcedDecision } from '../decisions'
import type { SettingsChange, TradeSpec } from '../spec'
import { HOUR_MS, lastSettledCycle, MINUTE_MS } from '../time'

// La simulación en vivo de todos los días: 16 días con US$ 1.000, 23 trades cerrados
// (14 ganados), tres abiertos, una moneda en penitencia por una racha de stops, otra
// en enfriamiento y otra sin datos. Los instantes se cuentan en horas antes del
// último ciclo que terminó de ejecutar, así el escenario vale para cualquier "ahora".

export const ACTIVE_SESSION_ID = 'sim_demo_activa'

export interface LiveScenarioContext {
  botSeenAt: number
  ownerEmail: string
}

export function hoursAgo(botSeenAt: number): (hours: number) => number {
  const lastCycle = lastSettledCycle(botSeenAt)
  return (hours) => lastCycle - hours * HOUR_MS
}

// FIL dejó de mandar datos 3 minutos antes del último latido, así la baldosa dice "sin
// datos hace 3 min" con cualquier "ahora". La decisión del último ciclo sólo la ve
// degradada si para ese cierre ya llevaba más de un minuto sin datos (decisions.ts).
const FIL_STALE_MS = 3 * MINUTE_MS

export function degradedFil(botSeenAt: number): LiveSpec['degraded'] {
  return { symbol: 'FILUSDT', since: botSeenAt - FIL_STALE_MS }
}

// La racha que dejó a WIF en penitencia: ocho stops seguidos en la moneda, siempre
// en largo y con días buenos de otras monedas en el medio.
function wifStreak(ago: (h: number) => number): TradeSpec[] {
  const opens = [330, 300, 268, 228, 196, 168, 138, 112]
  return opens.map((h, i) => ({
    id: `w${String(i + 1).padStart(2, '0')}`,
    symbol: 'WIFUSDT',
    side: 'long',
    open: ago(h),
    exit: { kind: 'stop', at: ago(h - 6 - (i % 2)) },
    strength: 0.38 + 0.03 * (i % 3),
  }))
}

export function activeTrades(ago: (h: number) => number): TradeSpec[] {
  return [
    { id: 'a01', symbol: 'SOLUSDT', side: 'long', open: ago(370), exit: { kind: 'take_profit', at: ago(361) }, strength: 0.52 },
    { id: 'a02', symbol: 'ETHUSDT', side: 'short', open: ago(352), exit: { kind: 'trailing_stop', at: ago(338), peakR: 1.6, peakAt: ago(345) }, strength: 0.47 },
    { id: 'a03', symbol: 'BTCUSDT', side: 'long', open: ago(316), exit: { kind: 'take_profit', at: ago(296) }, strength: 0.61 },
    { id: 'a04', symbol: 'LINKUSDT', side: 'long', open: ago(285), exit: { kind: 'market', reason: 'signal_flip', at: ago(274), r: 0.55 }, strength: 0.41 },
    { id: 'a05', symbol: 'AVAXUSDT', side: 'short', open: ago(250), exit: { kind: 'take_profit', at: ago(243) }, strength: 0.55 },
    {
      id: 'a06',
      symbol: 'DOGEUSDT',
      side: 'long',
      open: ago(236),
      exit: { kind: 'market', reason: 'manual', at: ago(231), r: 0.9 },
      strength: 0.44,
      shadowExit: { kind: 'take_profit', at: ago(220) },
    },
    { id: 'a07', symbol: 'SUIUSDT', side: 'long', open: ago(205), exit: { kind: 'trailing_stop', at: ago(187), peakR: 1.75, peakAt: ago(195) }, strength: 0.58 },
    { id: 'a08', symbol: 'BNBUSDT', side: 'short', open: ago(180), exit: { kind: 'time_exit', r: 0.28 }, strength: 0.39 },
    { id: 'a09', symbol: 'ETHUSDT', side: 'long', open: ago(150), exit: { kind: 'take_profit', at: ago(140) }, strength: 0.5 },
    { id: 'a10', symbol: 'XRPUSDT', side: 'short', open: ago(126), exit: { kind: 'market', reason: 'signal_flip', at: ago(118), r: 0.4 }, strength: 0.43 },
    { id: 'a11', symbol: 'SOLUSDT', side: 'short', open: ago(98), exit: { kind: 'take_profit', at: ago(92) }, strength: 0.57 },
    { id: 'a12', symbol: '1000PEPEUSDT', side: 'long', open: ago(80), exit: { kind: 'trailing_stop', at: ago(68), peakR: 1.5, peakAt: ago(73) }, strength: 0.49 },
    {
      id: 'a13',
      symbol: 'ADAUSDT',
      side: 'long',
      open: ago(60),
      exit: { kind: 'market', reason: 'manual', at: ago(51), r: 1.15 },
      strength: 0.46,
      shadowExit: { kind: 'take_profit', at: ago(45) },
    },
    { id: 'a14', symbol: 'BTCUSDT', side: 'short', open: ago(44), exit: { kind: 'take_profit', at: ago(31) }, strength: 0.63 },
    // Cierra por tiempo un cuarto de hora antes del último ciclo: NEAR queda enfriándose.
    { id: 'a15', symbol: 'NEARUSDT', side: 'long', open: ago(48.25), exit: { kind: 'time_exit', r: -0.25 }, strength: 0.4 },
    ...wifStreak(ago),
    { id: 'o01', symbol: 'ETHUSDT', side: 'long', open: ago(30), exit: { kind: 'open', r: 0.6 }, strength: 0.54, waypoints: [{ at: ago(14), r: 0.85 }] },
    { id: 'o02', symbol: 'AVAXUSDT', side: 'short', open: ago(10), exit: { kind: 'open', r: -0.45 }, strength: 0.42, waypoints: [{ at: ago(6), r: 0.3 }] },
    { id: 'o03', symbol: 'SOLUSDT', side: 'long', open: ago(0), exit: { kind: 'open', r: 0.12 }, strength: 0.6 },
  ]
}

// v1 con los valores por defecto; Toti probó blindar menos y volvió, y bajó el
// apalancamiento máximo unos días: por eso las abiertas tienen 2x, 3x y 5x.
export function activeSettings(startedAt: number, ago: (h: number) => number, by: string): SettingsChange[] {
  return [
    { at: startedAt, by, patch: {} },
    { at: ago(300) + 7 * 60_000, by, patch: { capital: { protectPct: 0.6, reinvest: true, onShield: 'reduce' } } },
    { at: ago(290) + 22 * 60_000, by, patch: { capital: { protectPct: 0.7, reinvest: true, onShield: 'reduce' } } },
    { at: ago(52) + 3 * 60_000, by, patch: { risk: { ...riskDefaults(), maxLeverage: 2 } } },
    { at: ago(20) + 11 * 60_000, by, patch: { risk: { ...riskDefaults(), maxLeverage: 3 } } },
    { at: ago(4) + 5 * 60_000, by, patch: { risk: riskDefaults() } },
  ]
}

function riskDefaults() {
  return { ...DEFAULT_SETTINGS.risk }
}

// S′ del último ciclo de las monedas que muestran cada motivo de bloqueo.
export function activeForced(): Map<string, ForcedDecision> {
  return new Map<string, ForcedDecision>([
    ['WIFUSDT', { sPrime: 0.44 }],
    ['NEARUSDT', { sPrime: 0.39 }],
    // `degraded` sólo si FIL ya estaba sin datos en ese ciclo (ver degradedFil).
    ['FILUSDT', { sPrime: -0.41 }],
    ['TRXUSDT', { sPrime: 0.45 }],
    ['ARBUSDT', { sPrime: 0.4, block: 'higher_trend_against' }],
    ['OPUSDT', { sPrime: -0.37, block: 'low_volume' }],
    ['ETHUSDT', { sPrime: 0.38 }],
    ['AVAXUSDT', { sPrime: -0.36 }],
  ])
}

export function activeSpec(ctx: LiveScenarioContext): LiveSpec {
  const ago = hoursAgo(ctx.botSeenAt)
  const startedAt = ago(16 * 24) - 37 * 60_000
  return {
    id: ACTIVE_SESSION_ID,
    name: 'Sereno en vivo',
    capitalInicial: 1000,
    startedAt,
    learningOrigin: 'zero',
    settings: activeSettings(startedAt, ago, ctx.ownerEmail),
    trades: activeTrades(ago),
    degraded: degradedFil(ctx.botSeenAt),
    forced: activeForced(),
  }
}
