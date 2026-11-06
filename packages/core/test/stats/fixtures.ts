import type { ClosedPosition } from '../../src/types'

interface ClosedOverrides extends Partial<Omit<ClosedPosition, 'costs'>> {
  costs?: Partial<ClosedPosition['costs']>
}

const RIESGO_REAL = 10

// Construye una posición cerrada con el mínimo que importa para estadísticas:
// `rMultiple` manda; `pnlNet` sale de riesgoReal × R salvo que se pase explícito.
export function makeClosed(overrides: ClosedOverrides = {}): ClosedPosition {
  const { costs: costOverrides, ...rest } = overrides
  const rMultiple = rest.rMultiple ?? 0
  const costs = { fees: 0, spread: 0, slippage: 0, funding: 0, ...costOverrides }
  const pnlNet = rest.pnlNet ?? rMultiple * RIESGO_REAL
  const totalCosts = costs.fees + costs.spread + costs.slippage + costs.funding
  return {
    id: 'pos-1',
    symbol: 'SOLUSDT',
    side: 'long',
    leverage: 5,
    margin: 100,
    notional: 500,
    qty: 5,
    entryPrice: 100,
    openedAt: 0,
    stopPrice: 98,
    takeProfitPrice: 104,
    liquidationPrice: 81,
    distanciaStop: 2,
    riesgoReal: RIESGO_REAL,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 100,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: costs.fees,
    fundingPaid: costs.funding,
    shadow: false,
    openReason: 'test',
    signalsAtOpen: [],
    mode: 'auto',
    closedAt: 3_600_000,
    exitPrice: 100 + rMultiple * 2,
    closeReason: rMultiple < 0 ? 'stop' : 'take_profit',
    pnlGross: pnlNet + totalCosts,
    pnlNet,
    rMultiple,
    ...rest,
    costs,
  }
}

export function closedFromR(rMultiples: number[]): ClosedPosition[] {
  return rMultiples.map((rMultiple, i) =>
    makeClosed({ id: `pos-${i + 1}`, rMultiple, openedAt: i * 3_600_000, closedAt: (i + 1) * 3_600_000 }),
  )
}
