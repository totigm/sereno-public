// El fill de una orden de mercado propia, con los números de Binance: lo que trae el stream,
// o REST vencido el plazo, completado si faltaron trades. Lo que no cierra (una comisión
// estimada, una orden que Binance no dio por terminada) se avisa como diferencia.
//
// Si Binance ya contestó la orden con su resultado final (el ack de `RESULT`) y después no se
// puede leer el fill (el stream no llega y REST falla: la misma sobrecarga), vale el ack: la
// orden se ejecutó y tirar dejaría en Binance una posición que nadie anotó.

import type { Logger } from 'pino'
import { classifyBinanceError } from '../binance/trade-errors'
import type { OrderAck } from '../binance/trade-types'
import { AccountStoppedError, OrderNotFoundError, type RealAccount } from './account'
import { completeFill, estimatedFill, type Completion, type TradesApi } from './fill-completion'
import { coinOf, fatalOrSame, type NoteSink } from './notes'
import { isFinalStatus, restFill, type OrderFill } from './order-tracker'

export interface FillReaderDeps {
  account: Pick<RealAccount, 'awaitOrderFill'>
  trade: TradesApi
  fillTimeoutMs: number
  // La vigente: cambia si el motor se rehace con otros ajustes.
  takerFeeRate: () => number
  onNote: NoteSink
  logger: Logger
}

export class FillReader {
  constructor(private readonly deps: FillReaderDeps) {}

  // null si Binance no tiene la orden: no entró. `pnlIfUnseen` estima el pnl realizado si
  // Binance no muestra ningún trade (0 al abrir; contra la entrada al cerrar). `ack`, la
  // respuesta de Binance al mandarla, si llegó.
  async read(symbol: string, clientOrderId: string, pnlIfUnseen: (fill: OrderFill) => number, ack: OrderAck | null = null): Promise<OrderFill | null> {
    const { account, onNote, logger } = this.deps
    let fill: OrderFill
    try {
      fill = await account.awaitOrderFill(symbol, clientOrderId, this.deps.fillTimeoutMs)
    } catch (err) {
      if (err instanceof AccountStoppedError) throw err
      const notFound = err instanceof OrderNotFoundError
      const fatal = !notFound && classifyBinanceError(err).kind === 'fatal'
      const acked = ack !== null && isFinalStatus(ack.status) ? restFill(ack, []) : null
      if (fatal || acked === null) {
        if (notFound) return null
        throw fatalOrSame(err, symbol, onNote)
      }
      logger.warn({ symbol, clientOrderId, err: err instanceof Error ? err.message : String(err) }, 'FillReader: no pude leer el fill; tomo lo que Binance contestó al mandar la orden')
      fill = acked
    }
    if (!isFinalStatus(fill.status)) {
      logger.warn({ symbol, clientOrderId, status: fill.status, qty: fill.qty }, 'FillReader: Binance no dio la orden por terminada; se toma lo ejecutado')
      onNote({ kind: 'mismatch', symbol, phrase: `Binance no me confirmó cómo terminó la orden ${clientOrderId} en ${coinOf(symbol)}: tomo lo ejecutado hasta ahora (${fill.qty}).`, data: { clientOrderId, status: fill.status, qty: fill.qty } })
    }
    const completed = await this.complete(symbol, fill, pnlIfUnseen)
    if (completed.estimated) {
      const { commission, realizedPnl } = completed.fill
      logger.warn({ symbol, clientOrderId, qty: fill.qty, commission, realizedPnl }, 'FillReader: Binance no informó todos los trades de la orden; se estimó la comisión')
      onNote({ kind: 'mismatch', symbol, phrase: `Binance no me pasó todos los trades de la orden ${clientOrderId} en ${coinOf(symbol)}: estimé la comisión.`, data: { clientOrderId, qty: fill.qty, commission, realizedPnl } })
    }
    return completed.fill
  }

  // Una falla pasajera al pedir los trades no tira el fill (la orden se ejecutó): la comisión
  // se estima y se avisa.
  private async complete(symbol: string, fill: OrderFill, pnlIfUnseen: (fill: OrderFill) => number): Promise<Completion> {
    const { trade, takerFeeRate, onNote, logger } = this.deps
    const estimate = { takerFeeRate: takerFeeRate(), realizedPnl: pnlIfUnseen }
    try {
      return await completeFill(trade, symbol, fill, estimate)
    } catch (err) {
      if (classifyBinanceError(err).kind === 'fatal') throw fatalOrSame(err, symbol, onNote)
      logger.warn({ symbol, clientOrderId: fill.clientOrderId, err: err instanceof Error ? err.message : String(err) }, 'FillReader: no pude leer los trades de la orden')
      return { fill: estimatedFill(fill, estimate), estimated: true }
    }
  }
}
