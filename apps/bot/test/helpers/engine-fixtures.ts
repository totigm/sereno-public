import type { AccountSnapshot, Fill, Position } from '@sereno/core'
import type { EngineSnapshot } from '@sereno/core/src/engine/types'
import { initialGuardState } from '@sereno/core/src/engine/account-guard'
import { initialLearningState } from '@sereno/core/src/learning/state'

// Piezas del motor armadas a mano para probar la persistencia sin correr un ciclo.

export function openPosition(overrides: Partial<Position> & Pick<Position, 'id' | 'symbol'>): Position {
  return {
    side: 'long',
    leverage: 3,
    margin: 100,
    notional: 300,
    qty: 2,
    entryPrice: 150,
    openedAt: Date.UTC(2026, 9, 31, 10, 0, 0),
    stopPrice: 145,
    takeProfitPrice: 160,
    liquidationPrice: 101,
    distanciaStop: 5 / 150,
    riesgoReal: 10,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 150,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0.15,
    fundingPaid: 0,
    shadow: false,
    openReason: 'Abrí un long en SOL.',
    signalsAtOpen: [],
    mode: 'auto',
    ...overrides,
  }
}

export function fillOf(p: Position, overrides: Partial<Fill> = {}): Fill {
  return { symbol: p.symbol, side: p.side === 'long' ? 'buy' : 'sell', price: p.entryPrice, qty: p.qty, fee: p.feesPaid, at: p.openedAt, spreadCost: 0.02, slippageCost: 0.03, ...overrides }
}

export function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    capitalInicial: 1000,
    saldo: 1000,
    equity: 1000,
    protegido: 0,
    baseBlindaje: 1000,
    capitalBase: 1000,
    capitalOperable: 1000,
    margenEnUso: 0,
    realizado: 0,
    unrealized: 0,
    reinvest: true,
    ...overrides,
  }
}

export function snapshotOf({ at, positions = [], real = account() }: { at: number; positions?: Position[]; real?: AccountSnapshot }): EngineSnapshot {
  const guard = initialGuardState(at)
  return {
    at,
    real: { positions: positions.filter((p) => !p.shadow).map((position) => ({ position, entryCosts: { spread: 0, slippage: 0 }, tickSize: 0.01 })), guard },
    shadow: {
      positions: positions.filter((p) => p.shadow).map((position) => ({ position, entryCosts: { spread: 0, slippage: 0 }, tickSize: 0.01 })),
      guard,
      learning: initialLearningState(at),
    },
    waitedAt: {},
    learning: initialLearningState(at),
    accounts: { real, shadow: account() },
  }
}
