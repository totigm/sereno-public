import type { ClosedPosition, Position } from '@sereno/core'

// Posiciones de prueba: un long 5x en SOL con números redondos (riesgo US$ 5, margen US$ 50).
export function position(id: string, patch: Partial<Position> = {}): Position {
  return {
    id,
    symbol: 'SOLUSDT',
    side: 'long',
    leverage: 5,
    margin: 50,
    notional: 250,
    qty: 2,
    entryPrice: 125,
    openedAt: Date.parse('2026-10-31T10:00:00Z'),
    stopPrice: 122.5,
    takeProfitPrice: 130,
    liquidationPrice: 101.2,
    distanciaStop: 2.5,
    riesgoReal: 5,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 125,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0.125,
    fundingPaid: 0,
    shadow: false,
    openReason: 'Abrí un long 5x en SOL con US$ 50.',
    signalsAtOpen: [
      { id: 'trend15m', value: 0.6 },
      { id: 'momentum', value: -0.2 },
      { id: 'funding', value: null },
    ],
    mode: 'auto',
    ...patch,
  }
}

export function closedPosition(id: string, patch: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    ...position(id),
    closedAt: Date.parse('2026-10-31T14:00:00Z'),
    exitPrice: 130,
    closeReason: 'take_profit',
    pnlGross: 10,
    pnlNet: 9.5,
    rMultiple: 1.9,
    costs: { fees: 0.25, spread: 0.15, slippage: 0.1, funding: 0 },
    ...patch,
  }
}
