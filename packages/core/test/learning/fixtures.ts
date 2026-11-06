import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { ClosedPosition, SignalId, SignalResult } from '../../src/types'

export const T0 = Date.UTC(2026, 9, 5) // lunes 5 de octubre de 2026, 00:00 UTC
export const DAY = 86_400_000
export const LEARNING = DEFAULT_SETTINGS.learning

export function signal(id: SignalId, value: number | null): SignalResult {
  return { id, value }
}

export interface ClosedOverrides {
  symbol?: string
  side?: 'long' | 'short'
  rMultiple?: number
  signals?: SignalResult[]
  openedAt?: number
  closedAt?: number
  shadow?: boolean
}

// Posición cerrada mínima pero completa: lo que importa para aprender es el símbolo,
// el lado, el R múltiplo y las señales que votaron al abrir.
export function makeClosed(o: ClosedOverrides = {}): ClosedPosition {
  const openedAt = o.openedAt ?? T0
  const riesgoReal = 10
  const rMultiple = o.rMultiple ?? 1
  return {
    id: `pos-${openedAt}`,
    symbol: o.symbol ?? 'SOLUSDT',
    side: o.side ?? 'long',
    leverage: 3,
    margin: 100,
    notional: 300,
    qty: 3,
    entryPrice: 100,
    openedAt,
    stopPrice: 96.7,
    takeProfitPrice: 106.6,
    liquidationPrice: 70,
    distanciaStop: 0.033,
    riesgoReal,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 100,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0.3,
    fundingPaid: 0,
    shadow: o.shadow ?? false,
    openReason: 'test',
    signalsAtOpen: o.signals ?? [],
    mode: 'auto',
    closedAt: o.closedAt ?? openedAt + 4 * 3_600_000,
    exitPrice: 100 + rMultiple * 3.3,
    closeReason: rMultiple > 0 ? 'take_profit' : 'stop',
    pnlGross: rMultiple * riesgoReal + 0.3,
    pnlNet: rMultiple * riesgoReal,
    rMultiple,
    costs: { fees: 0.3, spread: 0, slippage: 0, funding: 0 },
  }
}
