import type { ClosedPosition, Position, SignalId, SignalResult } from '@sereno/core'
import { positions } from '../schema'

export type PositionRow = typeof positions.$inferSelect
type PositionInsert = typeof positions.$inferInsert

// Lo que la base guarda además de lo que el motor conoce de una posición.
export interface PositionExtras {
  sessionId: string
  missingSignals: SignalId[]
  latencyMs: number | null
}

export type PositionRecord = Position & PositionExtras
export type ClosedPositionRecord = ClosedPosition & PositionExtras & { closePhrase: string | null }

// Las señales que faltaban al abrir son las que llegaron sin valor.
export function missingFrom(signals: readonly SignalResult[]): SignalId[] {
  return signals.filter((s) => s.value === null).map((s) => s.id)
}

export function openValues(sessionId: string, p: Position, extras: Partial<Omit<PositionExtras, 'sessionId'>> = {}) {
  return {
    id: p.id,
    sessionId,
    symbol: p.symbol,
    side: p.side,
    mode: p.mode,
    leverage: p.leverage,
    margin: p.margin,
    notional: p.notional,
    qty: p.qty,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
    takeProfitPrice: p.takeProfitPrice,
    liquidationPrice: p.liquidationPrice,
    trailingActive: p.trailingActive,
    bestPrice: p.bestPrice,
    riesgoReal: p.riesgoReal,
    distanciaStop: p.distanciaStop,
    thetaAtOpen: p.thetaAtOpen,
    stopOrderId: p.stopOrderId,
    tpOrderId: p.tpOrderId,
    fees: p.feesPaid,
    funding: p.fundingPaid,
    openReason: p.openReason,
    signalsAtOpen: p.signalsAtOpen,
    missingSignals: extras.missingSignals ?? missingFrom(p.signalsAtOpen),
    latencyMs: extras.latencyMs ?? null,
    openedAt: new Date(p.openedAt),
    shadow: p.shadow,
  } satisfies PositionInsert
}

export function closedValues(c: ClosedPosition, closePhrase: string) {
  return {
    exitPrice: c.exitPrice,
    closedAt: new Date(c.closedAt),
    closeReason: c.closeReason,
    closePhrase,
    pnlGross: c.pnlGross,
    pnlNet: c.pnlNet,
    rMultiple: c.rMultiple,
    costs: c.costs,
  } satisfies Partial<PositionInsert>
}

export function toPositionRecord(r: PositionRow): PositionRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    symbol: r.symbol,
    side: r.side,
    mode: r.mode,
    leverage: r.leverage,
    margin: r.margin,
    notional: r.notional,
    qty: r.qty,
    entryPrice: r.entryPrice,
    openedAt: r.openedAt.getTime(),
    stopPrice: r.stopPrice,
    takeProfitPrice: r.takeProfitPrice,
    liquidationPrice: r.liquidationPrice,
    distanciaStop: r.distanciaStop,
    riesgoReal: r.riesgoReal,
    thetaAtOpen: r.thetaAtOpen,
    trailingActive: r.trailingActive,
    bestPrice: r.bestPrice,
    stopOrderId: r.stopOrderId,
    tpOrderId: r.tpOrderId,
    feesPaid: r.fees,
    fundingPaid: r.funding,
    shadow: r.shadow,
    openReason: r.openReason,
    signalsAtOpen: r.signalsAtOpen,
    missingSignals: r.missingSignals,
    latencyMs: r.latencyMs,
  }
}

// Una fila cerrada sin precio de salida o sin resultado es una base corrupta:
// mejor fallar fuerte que mostrar un trade con ceros inventados.
export function toClosedRecord(r: PositionRow): ClosedPositionRecord {
  const { closedAt, exitPrice, closeReason, pnlGross, pnlNet, rMultiple, costs } = r
  if (
    closedAt === null ||
    exitPrice === null ||
    closeReason === null ||
    pnlGross === null ||
    pnlNet === null ||
    rMultiple === null ||
    costs === null
  ) {
    throw new Error(`La posición ${r.id} figura cerrada pero le faltan datos del cierre`)
  }
  return {
    ...toPositionRecord(r),
    closedAt: closedAt.getTime(),
    exitPrice,
    closeReason,
    pnlGross,
    pnlNet,
    rMultiple,
    costs,
    closePhrase: r.closePhrase,
  }
}
