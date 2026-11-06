// Filas de `position_events` a partir de los eventos del motor. Los payloads son el
// contrato con el dashboard: `stop_moved` = { from, to, phrase }, `funding` = { amount }
// con amount > 0 = pagado (como `fundingPaid`). El de `open` lleva además los costos de
// la entrada, que el runtime necesita para reconstruir el desglose de costos al reiniciar.
// `reported: true` (sólo en la sesión real) dice que los números son los que informó
// Binance: el diario lo muestra como "· datos de Binance".

import type { EngineEvent } from '@sereno/core'
import type { LearningLogEntry, PositionEventInput } from '@sereno/db'

type Of<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>

export interface OpenPayload {
  price: number
  qty: number
  fee: number
  spreadCost: number
  slippageCost: number
}

export function openEvent({ position, fill }: Of<'position_opened'>): PositionEventInput {
  const payload: OpenPayload = { price: fill.price, qty: fill.qty, fee: fill.fee, spreadCost: fill.spreadCost, slippageCost: fill.slippageCost }
  return { kind: 'open', payload: { ...payload, ...reportedOf(fill.reported) }, at: position.openedAt }
}

export function closeEvent({ position, fill, phrase }: Of<'position_closed'>): PositionEventInput {
  return {
    kind: position.closeReason === 'liquidation' ? 'liquidation' : 'close',
    payload: { price: fill.price, qty: fill.qty, fee: fill.fee, reason: position.closeReason, pnlNet: position.pnlNet, phrase, ...reportedOf(fill.reported) },
    at: position.closedAt,
  }
}

export function stopMovedEvent({ from, to, phrase, at }: Of<'stop_moved'>): PositionEventInput {
  return { kind: 'stop_moved', payload: { from, to, phrase }, at }
}

// El motor informa lo cobrado (positivo) o pagado (negativo); el payload, lo pagado.
// `reported`: el monto es el que cobró Binance (el evento del motor no lo dice; lo sabe la sesión).
export function fundingEvent({ amount, at }: Of<'funding_applied'>, reported = false): PositionEventInput {
  return { kind: 'funding', payload: { amount: amount === 0 ? 0 : -amount, ...reportedOf(reported) }, at }
}

// Sólo presente en true, como `Fill.reported`: los payloads de papel no cambian.
function reportedOf(reported: boolean | undefined): { reported?: true } {
  return reported ? { reported: true } : {}
}

// La fila de `learning_log` de un cambio de aprendizaje del motor.
export function learningEntry(e: Of<'learning_updated'>): LearningLogEntry {
  return {
    at: e.at,
    kind: e.kind ?? 'update',
    symbol: e.symbol ?? null,
    signal: e.signal ?? null,
    message: e.message,
    sampleSize: e.sampleSize,
    before: e.before,
    after: e.after,
  }
}

// Costos de la entrada guardados en el evento `open`; ceros si el payload no los trae.
export function entryCostsOf(payload: Record<string, unknown>): { spread: number; slippage: number } {
  const num = (key: string): number => {
    const v = payload[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return { spread: num('spreadCost'), slippage: num('slippageCost') }
}
