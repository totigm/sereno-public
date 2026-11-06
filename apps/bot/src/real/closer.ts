// Cerrar a mercado la posición del bot: `reduceOnly` por la cantidad del bot (nunca más: lo
// que Toti sumó a mano queda). Cada orden sale una sola vez (cabecera de `trade-rest.ts`). Si
// Binance dice que no la ejecutó (−1001, −1008, un 429), sale otra con otro id, con las
// esperas de la política y a lo sumo `CLOSE_SENDS` en total: sin eso, un cierre todo o un
// apagado que choca con un −1001 deja la moneda abierta. Un resultado desconocido nunca se
// reenvía: queda en duda (abajo). Si todos fallan, el próximo intento de quien pidió el
// cierre manda otra.
//
// - Un cierre que se llena en parte se acumula: el próximo llamado manda el resto y el fill
//   que se devuelve, al llegar a cero, es el agregado de todos. Si el resto lo cierra Binance
//   (un disparo), quien recibe ese cierre le suma lo acumulado (`takePartial`).
// - Una orden cuyo fill no se pudo saber (Binance no la tenía al consultar, o no se pudo
//   leer) se vuelve a consultar antes de mandar otra: si entró, cuenta como parte del
//   cierre. Mandar otra por el resto entero podría cerrar lo que Toti sumó a mano.
// - Los errores dicen sólo qué quedó: reintentar o no lo decide quien pidió el cierre (un
//   cierre del motor vuelve con el próximo precio o ciclo; uno que pidió Toti, no).
// - −2022 ("no hay posición que reducir"): el stop o el take profit ya disparó en Binance y el
//   evento todavía no llegó. Se espera ese disparo (y si no llega, se lo busca por REST) y se
//   devuelve su fill: nunca se manda una segunda orden ni se abre del otro lado.

import type { SymbolInfo } from '@sereno/core'
import { closingSide, direction } from '@sereno/core/src/exchange/sides'
import type { PositionState } from '@sereno/core/src/exchange/types'
import { BinanceHttpError } from '../binance/errors'
import { formatQty } from '../binance/precision'
import type { BinanceTradeRest } from '../binance/trade-rest'
import { isUnknownOutcome } from '../binance/trade-errors'
import type { OrderAck } from '../binance/trade-types'
import type { Clock } from '../live/timers'
import type { BotBook } from './bot-book'
import type { ClientIds } from './client-id'
import { triggeredByRest, type TriggerLookupApi } from './closing-fill'
import type { FillReader } from './fill-reader'
import { coinOf, fatalOrSame, type NoteSink } from './notes'
import type { OrderFill } from './order-tracker'
import { adverseCost, aggregateFills, type PartialClose } from './pending-close'
import { isSafeToResend, withRetries, type RetryPolicy } from './retry'

export type CloserTradeApi = Pick<BinanceTradeRest, 'marketOrder'> & TriggerLookupApi

export interface CloserDeps {
  trade: CloserTradeApi
  ids: ClientIds
  // El contrato vigente (cambia si el motor se rehace con otros contratos).
  infoOf: (symbol: string) => SymbolInfo
  clock: Clock
  retry: RetryPolicy
  book: BotBook
  fills: FillReader
  onNote: NoteSink
  // Los algos del bot en la moneda: si disparó uno, por ellos se encuentra el fill.
  algoIds: (symbol: string) => string[]
}

// Lo que el cierre necesita de la posición: qué cerrar y contra qué medir el pnl.
export type ClosingPosition = Pick<PositionState, 'symbol' | 'side' | 'qty' | 'entryPrice'>

export interface ClosedAtMarket {
  fill: OrderFill
  // El id de la última orden `c`, o el del algo que había disparado.
  orderId: string
  // Lo pagado de más contra el último precio al mandar cada parte.
  slippageCost: number
}

const NO_POSITION = -2022
// Envíos de una misma parte del cierre: la primera y a lo sumo dos más.
const CLOSE_SENDS = 3

// Binance ya no tiene la posición que se quería cerrar y no aparece qué la cerró.
export class PositionGoneError extends Error {
  override readonly name = 'PositionGoneError'
}

export class Closer {
  // Lo ya cerrado de una posición que quedó a medias, por moneda.
  private readonly partials = new Map<string, PartialClose>()
  // La última orden `c` en duda por moneda.
  private readonly doubtful = new Map<string, string>()

  constructor(private readonly deps: CloserDeps) {}

  async close(position: ClosingPosition): Promise<ClosedAtMarket> {
    const { symbol } = position
    const { trade, ids, book, fills, onNote } = this.deps
    const info = this.deps.infoOf(symbol)
    const pnlOf = (f: OrderFill) => direction(position.side) * (f.avgPrice - position.entryPrice) * f.qty
    const done = this.partials.get(symbol) ?? { fills: [], slippage: 0 }
    await this.recheckDoubtful(symbol, done, pnlOf)
    const closed = qtyOf(done)
    const quantity = formatQty(Math.max(0, position.qty - closed), info.stepSize)
    if (!(Number(quantity) > 0)) return this.finish(symbol, done, done.fills.at(-1)?.clientOrderId ?? '')
    const side = closingSide(position.side)
    const reference = book.pricesOf(symbol).last
    // El id del último envío: el único que pudo entrar.
    let clientOrderId = ''
    const send = () => {
      clientOrderId = ids.next('c')
      return trade.marketOrder({ symbol, side: side === 'buy' ? 'BUY' : 'SELL', quantity, reduceOnly: true, clientOrderId })
    }
    let ack: OrderAck | null = null
    try {
      ack = await withRetries(this.deps.clock, this.deps.retry.delaysMs.slice(0, CLOSE_SENDS), send, isSafeToResend)
    } catch (err) {
      if (isNoPosition(err)) return this.afterTrigger(position, done)
      // En duda aun después de consultar: la lectura del fill vuelve a preguntar por el id.
      if (!isUnknownOutcome(err)) throw fatalOrSame(err, symbol, onNote)
    }
    let fill: OrderFill | null
    try {
      fill = await fills.read(symbol, clientOrderId, pnlOf, ack)
    } catch (err) {
      this.doubtful.set(symbol, clientOrderId)
      throw err
    }
    if (fill === null) {
      this.doubtful.set(symbol, clientOrderId)
      throw new Error(`la orden de cierre ${clientOrderId} en ${coinOf(symbol)} no entró en Binance; la posición sigue abierta con su stop`)
    }
    if (fill.qty > 0) {
      done.fills.push(fill)
      done.slippage += adverseCost(side, fill.avgPrice, reference, fill.qty)
    }
    const total = closed + fill.qty
    if (position.qty - total > info.stepSize / 2) {
      this.partials.set(symbol, done)
      throw new Error(`cerré ${total} de ${position.qty} en ${coinOf(symbol)}; lo demás sigue abierto con su stop`)
    }
    return this.finish(symbol, done, clientOrderId)
  }

  // Lo cerrado a medias de la moneda, que deja de estar acá: lo usa quien recibe el cierre
  // que terminó Binance. undefined si no había nada.
  takePartial(symbol: string): PartialClose | undefined {
    const partial = this.partials.get(symbol)
    this.forget(symbol)
    return partial
  }

  // Lo que el bot ya cerró a mercado de la posición sin terminar.
  closedQty(symbol: string): number {
    const partial = this.partials.get(symbol)
    return partial ? qtyOf(partial) : 0
  }

  // La posición ya no es del bot: lo cerrado a medias y lo que quedó en duda se olvidan.
  private forget(symbol: string): void {
    this.partials.delete(symbol)
    this.doubtful.delete(symbol)
  }

  // La orden en duda de la vez anterior, consultada otra vez: si Binance la llenó, suma a lo
  // cerrado. Si todavía no se puede leer, tira sin mandar nada.
  private async recheckDoubtful(symbol: string, done: PartialClose, pnlOf: (f: OrderFill) => number): Promise<void> {
    const id = this.doubtful.get(symbol)
    if (id === undefined) return
    const fill = await this.deps.fills.read(symbol, id, pnlOf)
    this.doubtful.delete(symbol)
    if (fill === null || fill.qty <= 0) return
    done.fills.push(fill)
    this.partials.set(symbol, done)
  }

  private async afterTrigger(position: ClosingPosition, done: PartialClose): Promise<ClosedAtMarket> {
    const { symbol } = position
    const { book, clock, retry, trade, onNote, algoIds } = this.deps
    let trigger = await book.waitClose(symbol, retry.fillTimeoutMs, clock)
    if (trigger === null) {
      try {
        trigger = await triggeredByRest(trade, symbol, algoIds(symbol))
      } catch (err) {
        throw fatalOrSame(err, symbol, onNote)
      }
    }
    if (trigger === null) throw new PositionGoneError(`Binance ya no tiene la posición del bot en ${coinOf(symbol)} y no encontré qué la cerró; lo resuelve la reconciliación`)
    return this.finish(symbol, { fills: [...done.fills, trigger.fill], slippage: done.slippage }, trigger.orderId ?? trigger.fill.clientOrderId)
  }

  private finish(symbol: string, done: PartialClose, orderId: string): ClosedAtMarket {
    this.forget(symbol)
    return { fill: aggregateFills(done.fills), orderId, slippageCost: done.slippage }
  }
}

function qtyOf(partial: PartialClose): number {
  return partial.fills.reduce((sum, f) => sum + f.qty, 0)
}

function isNoPosition(err: unknown): boolean {
  return err instanceof BinanceHttpError && err.code === NO_POSITION
}
