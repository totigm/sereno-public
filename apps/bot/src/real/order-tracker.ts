// Junta los `ORDER_TRADE_UPDATE` de cada orden hasta su estado final y arma el fill con los
// números de Binance: cantidad y precio promedio de la orden; comisión y pnl realizado
// sumados trade por trade. Guarda todas las órdenes (no sólo las del bot): la que nace al
// disparar un stop lleva un id de Binance y se vincula después por su `orderId`.

import type { OrderAck, OrderTradeUpdate, UserTrade } from '../binance/trade-types'

export interface OrderFill {
  clientOrderId: string
  orderId: number
  qty: number
  avgPrice: number
  // En USDT.
  commission: number
  realizedPnl: number
  at: number
  status: string
  // false si Binance no informó todos los trades de lo ejecutado: la comisión y el pnl
  // quedan cortos y quien lo usa tiene que completarlos (`fill-completion.ts`).
  complete: boolean
}

export interface TrackedOrder {
  symbol: string
  clientOrderId: string
  orderId: number
  status: string
  final: boolean
  cumQty: number
  avgPrice: number
  commission: number
  realizedPnl: number
  at: number
  // La moneda de una comisión que no fue en USDT (el descuento con BNB prendido).
  foreignFeeAsset: string | null
  // Reloj local de la última novedad, para olvidarla.
  seenAt: number
}

const FINAL_STATUSES: ReadonlySet<string> = new Set(['FILLED', 'EXPIRED', 'CANCELED', 'REJECTED', 'EXPIRED_IN_MATCH'])
const FEE_ASSET = 'USDT'
const QTY_TOLERANCE = 1e-9

export class OrderTracker {
  private readonly orders = new Map<number, TrackedOrder>()

  constructor(
    private readonly now: () => number,
    // Una orden que nadie reclamó se olvida pasado este lapso.
    private readonly retainMs: number,
    // Las que alguien espera (un fill pedido, un disparo sin avisar) no se olvidan nunca.
    private readonly claimed: (order: TrackedOrder) => boolean,
  ) {}

  apply(u: OrderTradeUpdate): TrackedOrder {
    this.prune()
    let order = this.orders.get(u.orderId)
    if (!order) {
      order = { symbol: u.symbol, clientOrderId: u.clientOrderId, orderId: u.orderId, status: u.status, final: false, cumQty: 0, avgPrice: 0, commission: 0, realizedPnl: 0, at: u.at, foreignFeeAsset: null, seenAt: 0 }
      this.orders.set(u.orderId, order)
    }
    if (u.execType === 'TRADE') {
      order.commission += u.commission
      order.realizedPnl += u.realizedPnl
      if (u.commission !== 0 && u.commissionAsset !== FEE_ASSET) order.foreignFeeAsset = u.commissionAsset ?? 'desconocida'
    }
    if (u.cumQty >= order.cumQty) {
      order.cumQty = u.cumQty
      order.avgPrice = u.avgPrice
    }
    if (!order.final) {
      order.status = u.status
      order.final = isFinalStatus(u.status)
    }
    order.at = Math.max(order.at, u.at)
    order.seenAt = this.now()
    return order
  }

  get(orderId: number): TrackedOrder | undefined {
    return this.orders.get(orderId)
  }

  // La última con ese id de cliente (Binance deja repetirlo una vez llena la anterior).
  byClientId(symbol: string, clientOrderId: string): TrackedOrder | undefined {
    let found: TrackedOrder | undefined
    for (const order of this.orders.values()) {
      if (order.symbol === symbol && order.clientOrderId === clientOrderId) found = order
    }
    return found
  }

  forget(orderId: number): void {
    this.orders.delete(orderId)
  }

  private prune(): void {
    const cutoff = this.now() - this.retainMs
    for (const [id, order] of this.orders) if (order.seenAt < cutoff && !this.claimed(order)) this.orders.delete(id)
  }
}

export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status)
}

export function streamFill(order: TrackedOrder): OrderFill {
  if (order.foreignFeeAsset !== null) throw foreignFee(order.clientOrderId, order.foreignFeeAsset)
  const { clientOrderId, orderId, cumQty, avgPrice, commission, realizedPnl, at, status } = order
  // Cada trade del stream llega con su comisión: una orden final los trae todos.
  return { clientOrderId, orderId, qty: cumQty, avgPrice, commission, realizedPnl, at, status, complete: true }
}

// Cantidad, precio y estado de la orden; comisión y pnl de sus trades. `complete` dice si
// la orden es final y sus trades suman lo ejecutado.
export function restFill(ack: OrderAck, trades: readonly UserTrade[]): OrderFill {
  let commission = 0
  let realizedPnl = 0
  let at = ack.updateTime
  for (const t of trades) {
    if (t.commission !== 0 && t.commissionAsset !== FEE_ASSET) throw foreignFee(ack.clientOrderId, t.commissionAsset)
    commission += t.commission
    realizedPnl += t.realizedPnl
    at = Math.max(at, t.time)
  }
  const traded = trades.reduce((sum, t) => sum + t.qty, 0)
  const complete = isFinalStatus(ack.status) && Math.abs(traded - ack.executedQty) <= QTY_TOLERANCE
  return { clientOrderId: ack.clientOrderId, orderId: ack.orderId, qty: ack.executedQty, avgPrice: ack.avgPrice, commission, realizedPnl, at, status: ack.status, complete }
}

// La contabilidad de la sesión es en USDT: una comisión en otra moneda la rompería.
function foreignFee(clientOrderId: string, asset: string): Error {
  return new Error(`Binance cobró la comisión de ${clientOrderId} en ${asset}, no en USDT: el descuento de comisiones con BNB tiene que estar apagado`)
}
