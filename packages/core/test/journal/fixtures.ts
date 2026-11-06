import type { AccountSnapshot, ClosedPosition, Composite, Position, SignalId, SignalResult } from '../../src/types'
import { signalRecord } from '../../src/learning/state'

export const T0 = Date.UTC(2026, 9, 14, 13, 15) // 14 de octubre de 2026, 10:15 en Buenos Aires

// Posición mínima y determinista: lo que importa para las frases es símbolo, lado,
// apalancamiento, margen y precios. Se sobreescribe sólo lo que cada caso necesita.
export function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    symbol: 'SOLUSDT',
    side: 'long',
    leverage: 5,
    margin: 50,
    notional: 250,
    qty: 1.76,
    entryPrice: 142.1,
    openedAt: T0,
    stopPrice: 138.5,
    takeProfitPrice: 149.3,
    liquidationPrice: 115.2,
    distanciaStop: 3.6,
    riesgoReal: 6.2,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 142.1,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0,
    fundingPaid: 0,
    shadow: false,
    openReason: '',
    signalsAtOpen: [],
    mode: 'auto',
    ...overrides,
  }
}

export function closed(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    ...position(),
    closedAt: T0 + 3 * 3_600_000,
    exitPrice: 149.3,
    closeReason: 'take_profit',
    pnlGross: 12.67,
    pnlNet: 12.4,
    rMultiple: 2,
    costs: { fees: 0.27, spread: 0, slippage: 0, funding: 0 },
    ...overrides,
  }
}

export function signal(id: SignalId, value: number | null): SignalResult {
  return { id, value }
}

// Compuesto con peso 1 en todas las señales: cada test fija las que entran y los
// pesos que quiere distintos de 1.
export function composite(overrides: Partial<Omit<Composite, 'weights'>> & { weights?: Partial<Composite['weights']> } = {}): Composite {
  const { weights, ...rest } = overrides
  return {
    S: 0.5,
    Sprime: 0.5,
    confidence: 0.5,
    signals: [],
    missing: [],
    modifiers: { adx: 1, vol: 1 },
    relVolume: 1,
    higherTrendAgainst: 0,
    ...rest,
    weights: { ...signalRecord(1), ...(weights ?? {}) },
  }
}

export function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    capitalInicial: 1000,
    saldo: 1248,
    equity: 1248,
    protegido: 0,
    baseBlindaje: 1000,
    capitalBase: 1248,
    capitalOperable: 1248,
    margenEnUso: 0,
    realizado: 248,
    unrealized: 0,
    reinvest: true,
    ...overrides,
  }
}
