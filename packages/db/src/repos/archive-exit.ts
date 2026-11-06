import type { ClosedPosition, Position } from '@sereno/core'
import { fillPrice, slippageForNotional } from '@sereno/core/src/exchange/fills'
import { closingSide, direction } from '@sereno/core/src/exchange/sides'

export interface ExitCosts {
  takerFeeRate: number
  // Slippage base; el de cada pata suma el escalón por nocional.
  slippageRate: number
  halfSpreadRate: number
}

// Medio spread por defecto mientras no haya mediana observada (spec §6).
const MAJORS = new Set(['BTCUSDT', 'ETHUSDT'])
export function defaultHalfSpread(symbol: string): number {
  return MAJORS.has(symbol) ? 0.0001 : 0.00025
}

// Cierre a mercado de una abierta al archivar la simulación, con el fill del
// simulador (`core/exchange/fills`). El snapshot de mercado sólo guarda el precio
// de marca, así que se llena a la marca (no al último precio, como un fill en
// vivo) con medio spread y slippage en contra, y comisión taker sobre el nocional
// de salida. El resultado sigue la spec §6:
// `pnlNeto = pnlBruto − comisiones − funding pagado`, `R = pnlNeto / riesgoReal`.
//
// Los costos cuentan las dos patas, como `ClosedPosition.costs` del simulador
// (`feesPaid` ya trae la comisión de entrada). La posición no guarda el spread ni
// el slippage de su entrada: se reconstruyen sobre su nocional con las tasas de hoy.
export function exitAtMark(p: Position, markPrice: number, costs: ExitCosts, closedAt: number): ClosedPosition {
  const exit = fillPrice({
    lastPrice: markPrice,
    halfSpreadRate: costs.halfSpreadRate,
    slippageRate: costs.slippageRate,
    notional: markPrice * p.qty,
    side: closingSide(p.side),
  })
  const fees = p.feesPaid + exit.price * p.qty * costs.takerFeeRate
  const pnlGross = direction(p.side) * (exit.price - p.entryPrice) * p.qty
  const pnlNet = pnlGross - fees - p.fundingPaid
  return {
    ...p,
    feesPaid: fees,
    closedAt,
    exitPrice: exit.price,
    closeReason: 'session_archived',
    pnlGross,
    pnlNet,
    rMultiple: pnlNet / p.riesgoReal,
    costs: {
      fees,
      spread: exit.spreadCost + p.notional * costs.halfSpreadRate,
      slippage: exit.slippageCost + p.notional * slippageForNotional(costs.slippageRate, p.notional),
      funding: p.fundingPaid,
    },
  }
}
