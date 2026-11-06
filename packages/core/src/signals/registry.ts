// Las diez señales de la spec §5.3a, indexadas por `SignalId`. `satisfies` obliga a que
// cada id tenga su función: agregar un `SignalId` sin señal no compila.
import { SIGNAL_IDS, type MarketView, type SignalId, type SignalResult } from '../types'
import { bands } from './bands'
import { breakout } from './breakout'
import { btcRegime } from './btc-regime'
import { funding } from './funding'
import { momentum } from './momentum'
import { openInterest } from './open-interest'
import { positioning } from './positioning'
import { trend15m } from './trend-15m'
import { trendHigher } from './trend-higher'
import { vwap } from './vwap'

export type Signal = (view: MarketView) => SignalResult

export const SIGNALS = {
  trend15m,
  trendHigher,
  momentum,
  breakout,
  bands,
  vwap,
  funding,
  openInterest,
  positioning,
  btcRegime,
} as const satisfies Record<SignalId, Signal>

// Todas las señales de la vista, en el orden canónico de `SIGNAL_IDS`.
export function evaluateSignals(view: MarketView): SignalResult[] {
  return SIGNAL_IDS.map((id) => SIGNALS[id](view))
}
