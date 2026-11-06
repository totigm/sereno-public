import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { LiveSpec } from '../live'
import type { SettingsChange, TradeSpec } from '../spec'
import { activeForced, activeTrades, ACTIVE_SESSION_ID, degradedFil, hoursAgo, type LiveScenarioContext } from './active'

// La misma simulación que `active` con un riesgo más alto desde el primer día y más
// take profits: la ganancia pasa el 70% del capital inicial, el blindaje se dispara y
// cierra la peor de las abiertas para que el margen entre en el colchón.

const SHIELD_HOURS_AGO = 16
const AGGRESSIVE_RISK = { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.025, maxMarginPerTrade: 0.35, maxMarginInUse: 0.9, maxNotionalMultiple: 6, dailyLossLimit: 0.06 }

function shieldedSettings(startedAt: number, by: string): SettingsChange[] {
  return [
    { at: startedAt, by, patch: {} },
    { at: startedAt + 40 * 60_000, by, patch: { risk: AGGRESSIVE_RISK } },
  ]
}

function extraTrades(ago: (h: number) => number): TradeSpec[] {
  const tp = (id: string, symbol: string, side: 'long' | 'short', open: number, close: number, strength: number): TradeSpec => ({
    id,
    symbol,
    side,
    open: ago(open),
    exit: { kind: 'take_profit', at: ago(close) },
    strength,
  })
  return [
    tp('x01', 'FETUSDT', 'long', 375, 368, 0.55),
    tp('x02', 'APTUSDT', 'short', 330, 322, 0.5),
    tp('x03', 'LTCUSDT', 'long', 310, 300, 0.47),
    tp('x04', 'INJUSDT', 'long', 262, 255, 0.58),
    tp('x05', 'AAVEUSDT', 'short', 215, 208, 0.52),
    tp('x06', 'DOTUSDT', 'long', 172, 165, 0.49),
    tp('x07', 'UNIUSDT', 'short', 130, 122, 0.54),
    tp('x08', 'ATOMUSDT', 'long', 105, 97, 0.51),
    { id: 'x09', symbol: 'BCHUSDT', side: 'long', open: ago(75), exit: { kind: 'trailing_stop', at: ago(70), peakR: 1.5, peakAt: ago(72) }, strength: 0.56 },
    tp('x10', 'LTCUSDT', 'short', 29, 24, 0.5),
    // El take profit que lleva la ganancia sobre el 70%: el blindaje se dispara en ese ciclo.
    tp('x11', 'APTUSDT', 'long', 21, SHIELD_HOURS_AGO, 0.53),
    {
      id: 's01',
      symbol: 'DOTUSDT',
      side: 'short',
      open: ago(22),
      exit: { kind: 'market', reason: 'shield_reduce', at: ago(SHIELD_HOURS_AGO), r: -0.6 },
      strength: 0.45,
      // Sin blindaje la sombra la lleva hasta el stop.
      shadowExit: { kind: 'stop', at: ago(12) },
    },
    // Ya blindado opera con el colchón.
    { id: 'x12', symbol: 'LINKUSDT', side: 'long', open: ago(8), exit: { kind: 'open', r: 0.5 }, strength: 0.48 },
  ]
}

// NEAR, con un stop más ancho (y menos margen), casi en cero al blindar: la peor
// abierta es la venta en DOT y al cerrarla el margen ya entra en el colchón. La
// compra de ETH llega al take profit y libera margen para operar blindado.
function adjust(t: TradeSpec, ago: (h: number) => number): TradeSpec {
  if (t.id === 'a15') return { ...t, atrScale: 2, waypoints: [{ at: ago(SHIELD_HOURS_AGO), r: -0.05 }] }
  if (t.id === 'o01') return { ...t, exit: { kind: 'take_profit', at: ago(9) } }
  return t
}

export function shieldedSpec(ctx: LiveScenarioContext): LiveSpec {
  const ago = hoursAgo(ctx.botSeenAt)
  const startedAt = ago(16 * 24) - 37 * 60_000
  return {
    id: ACTIVE_SESSION_ID,
    name: 'Sereno en vivo',
    capitalInicial: 1000,
    startedAt,
    learningOrigin: 'zero',
    settings: shieldedSettings(startedAt, ctx.ownerEmail),
    // Después del blindaje no queda capital operable para la venta en AVAX de `active`.
    trades: [...activeTrades(ago).filter((t) => t.id !== 'o02').map((t) => adjust(t, ago)), ...extraTrades(ago)],
    degraded: degradedFil(ctx.botSeenAt),
    forced: activeForced(),
  }
}
