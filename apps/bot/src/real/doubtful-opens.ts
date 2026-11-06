// Aperturas `o` que quedaron en duda: Binance no confirmó la orden y al consultarla no la
// tenía, o no se pudo leer su fill sin un ack que lo diga. El motor la dio por fallida, pero
// si Binance la llenó (tarde) hay en la moneda una posición del bot que nadie anotó ni
// protege. Se consulta otra vez por su id antes de volver a abrir en la moneda y en cada
// vuelta de la reconciliación: si se llenó, se cierra a mercado en el acto, `reduceOnly` por
// exactamente lo que se llenó (que es del bot lo prueba su id con el prefijo de la sesión).
// Si Binance sigue sin tenerla, se espera un rato por si la registra tarde y después se olvida.
//
// Ni esa apertura ni su cierre pasan por el motor ni por la billetera de la sesión (el motor
// mide sus cierres por la diferencia de saldo y esto puede pasar en medio de uno): lo que
// costó va en la nota `unprotected`.

import type { Side } from '@sereno/core'
import type { Logger } from 'pino'
import type { Clock } from '../live/timers'
import { PositionGoneError, type Closer } from './closer'
import type { FillReader } from './fill-reader'
import { coinOf, type NoteSink } from './notes'
import type { OrderFill } from './order-tracker'
import { realizedOf } from './pending-close'

export interface DoubtfulOpensDeps {
  fills: Pick<FillReader, 'read'>
  // Un cerrador propio: en la moneda no hay posición ni algos del bot.
  closer: Pick<Closer, 'close'>
  clock: Clock
  onNote: NoteSink
  logger: Logger
}

export interface DoubtfulOpen {
  clientOrderId: string
  side: Side
  // Reloj local al mandarla.
  sentAt: number
}

// `pending`: Binance todavía no la tiene y puede registrarla tarde.
export type DoubtOutcome = 'clear' | 'pending' | 'closed'

interface Doubt extends DoubtfulOpen {
  // Lo que Binance llenó, una vez visto: falta cerrarlo (un cierre a medias sigue después).
  fill: OrderFill | null
}

// Cuánto se sigue esperando una orden que Binance no tiene: un resultado desconocido se
// resuelve en segundos.
const UNSEEN_WINDOW_MS = 2 * 60_000

export class DoubtfulOpens {
  private readonly doubts = new Map<string, Doubt>()
  private readonly running = new Map<string, Promise<DoubtOutcome>>()

  constructor(private readonly deps: DoubtfulOpensDeps) {}

  remember(symbol: string, open: DoubtfulOpen): void {
    this.doubts.set(symbol, { ...open, fill: null })
  }

  has(symbol: string): boolean {
    return this.doubts.has(symbol)
  }

  symbols(): string[] {
    return [...this.doubts.keys()]
  }

  // De a una por moneda: la reconciliación y una apertura nueva no la cierran dos veces.
  resolve(symbol: string): Promise<DoubtOutcome> {
    const running = this.running.get(symbol)
    if (running) return running
    const task = this.resolveNow(symbol).finally(() => this.running.delete(symbol))
    this.running.set(symbol, task)
    return task
  }

  private async resolveNow(symbol: string): Promise<DoubtOutcome> {
    const doubt = this.doubts.get(symbol)
    if (!doubt) return 'clear'
    if (doubt.fill === null) {
      const fill = await this.deps.fills.read(symbol, doubt.clientOrderId, () => 0)
      if (fill === null && this.deps.clock.now() - doubt.sentAt < UNSEEN_WINDOW_MS) return 'pending'
      if (fill === null || fill.qty <= 0) {
        this.doubts.delete(symbol)
        this.deps.logger.info({ symbol, clientOrderId: doubt.clientOrderId }, 'DoubtfulOpens: la apertura en duda no se ejecutó en Binance')
        return 'clear'
      }
      doubt.fill = fill
    }
    return this.closeFilled(symbol, doubt, doubt.fill)
  }

  private async closeFilled(symbol: string, doubt: Doubt, open: OrderFill): Promise<DoubtOutcome> {
    const { closer, onNote } = this.deps
    const coin = coinOf(symbol)
    const base = { clientOrderId: doubt.clientOrderId, qty: open.qty, entryPrice: open.avgPrice }
    let closed
    try {
      closed = await closer.close({ symbol, side: doubt.side, qty: open.qty, entryPrice: open.avgPrice })
    } catch (err) {
      if (!(err instanceof PositionGoneError)) throw err
      this.doubts.delete(symbol)
      onNote({ kind: 'mismatch', symbol, phrase: `Una apertura en ${coin} quedó en duda y Binance la llenó, pero cuando fui a cerrarla ya no estaba.`, data: base })
      return 'closed'
    }
    this.doubts.delete(symbol)
    onNote({
      kind: 'unprotected',
      symbol,
      phrase: `Una apertura en ${coin} quedó en duda y Binance la llenó: la cerré para no dejarla sin protección.`,
      data: { ...base, exitPrice: closed.fill.avgPrice, closeOrderId: closed.orderId, realized: realizedOf(open) + realizedOf(closed.fill) },
    })
    return 'closed'
  }
}
