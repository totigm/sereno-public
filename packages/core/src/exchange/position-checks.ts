import { EPSILON } from '../risk/epsilon'
import { liquidationPrice } from '../risk/liquidation'
import { floorToStep } from '../risk/sizing'
import type { SymbolInfo } from '../types'
import type { PositionState, RestoreResult } from './types'

// Validaciones de cantidades y posiciones contra las reglas del contrato.

export function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function assertQty(qty: number, info: SymbolInfo): void {
  if (!isPositive(qty)) throw new RangeError(`cantidad inválida: ${qty}`)
  if (floorToStep(qty, info.stepSize) !== qty) throw new RangeError(`cantidad ${qty} fuera del stepSize ${info.stepSize} de ${info.symbol}`)
  if (qty < info.minQty) throw new RangeError(`cantidad ${qty} por debajo del minQty ${info.minQty} de ${info.symbol}`)
}

// Un resto que Binance ya no dejaría cerrar con una orden propia (por debajo de `minQty`
// o de `minNotional` al último precio). Un resto de 0 no es polvo: ya no hay posición.
export function leavesDust(positionQty: number, closeQty: number, last: number, info: SymbolInfo): boolean {
  const remaining = floorToStep(positionQty - closeQty, info.stepSize)
  if (remaining <= 0) return false
  return remaining < info.minQty || remaining * last + EPSILON < info.minNotional
}

export interface WalletView {
  total: number
  marginInUse: number
  // Funding neto pagado por las abiertas (las ya restauradas más esta), o 0 si cobraron.
  fundingPaid: number
}

// Una fila persistida corrupta tiene que fallar al restaurar y no después, a mitad de un
// cierre. El margen se compara contra el saldo total porque el saldo inicial de una
// restauración ya incluye el margen de las abiertas. El funding sale de la billetera y no
// del margen aislado (`applyFunding`): en vivo el saldo puede quedar debajo de los márgenes
// por lo que pagaron las abiertas, y eso no es una fila corrupta. Ese exceso se tolera:
// sin esto una sesión así no volvería a arrancar nunca. La liquidación guardada no se compara
// con la fórmula (la recalcula `restoredLiquidation`): sólo falla si no es un precio.
export function assertRestorable(state: PositionState, info: SymbolInfo, wallet: WalletView): void {
  assertQty(state.qty, info)
  if (!isPositive(state.entryPrice)) throw new RangeError(`precio de entrada inválido en ${state.symbol}: ${state.entryPrice}`)
  if (!(Number.isInteger(state.leverage) && state.leverage >= 1)) throw new RangeError(`apalancamiento inválido en ${state.symbol}: ${state.leverage}`)
  if (!isPositive(state.margin)) throw new RangeError(`margen inválido en ${state.symbol}: ${state.margin}`)
  // Un long 1x liquida en 0: es el único precio no positivo que da la fórmula.
  if (!(Number.isFinite(state.liquidationPrice) && state.liquidationPrice >= 0)) {
    throw new RangeError(`liquidación inválida en ${state.symbol}: ${state.liquidationPrice}`)
  }
  if (wallet.marginInUse + state.margin > wallet.total + Math.max(0, wallet.fundingPaid) + EPSILON) {
    throw new RangeError(
      `el margen ${state.margin} de ${state.symbol} no entra en el saldo ${wallet.total} (ya hay ${wallet.marginInUse} en uso y ${wallet.fundingPaid} de funding pagado)`,
    )
  }
}

// Como en Binance, la liquidación de una abierta sale del `mmr` vigente del contrato: si
// cambió entre reinicios, la guardada ya no vale y se usa la recalculada. Una diferencia
// dentro de la tolerancia común es residuo de coma flotante: se conserva la guardada.
export function restoredLiquidation(state: PositionState, info: SymbolInfo): RestoreResult['liquidationRecalculated'] {
  const expected = liquidationPrice(state.side, state.entryPrice, state.leverage, info.mmr)
  if (Math.abs(state.liquidationPrice - expected) <= EPSILON) return null
  return { from: state.liquidationPrice, to: expected }
}
