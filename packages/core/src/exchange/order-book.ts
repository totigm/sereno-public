import type { Order, OrderId } from './types'

// Órdenes condicionales vivas del simulador. Los ids salen de un contador por
// instancia: dos simuladores con la misma historia dan los mismos ids (replay
// determinista).
export class OrderBook {
  private readonly orders = new Map<OrderId, Order>()
  private seq = 0

  place(order: Omit<Order, 'id'>): OrderId {
    // Binance admite una sola orden closePosition por símbolo, tipo y lado (error -4130):
    // mover un stop es cancelar el viejo y colocar el nuevo.
    const duplicate = [...this.orders.values()].some((o) => o.symbol === order.symbol && o.type === order.type && o.side === order.side)
    if (duplicate) throw new Error(`ya hay una orden ${order.type} ${order.side} en ${order.symbol}`)
    this.seq += 1
    const id = `paper-${this.seq}`
    this.orders.set(id, { id, ...order })
    return id
  }

  cancel(symbol: string, id: OrderId): void {
    const order = this.orders.get(id)
    if (!order || order.symbol !== symbol) throw new Error(`orden desconocida: ${id} en ${symbol}`)
    this.orders.delete(id)
  }

  cancelAll(symbol: string): void {
    for (const order of this.list(symbol)) this.orders.delete(order.id)
  }

  // Copias en orden de colocación, para que nadie mute el libro desde afuera.
  list(symbol?: string): Order[] {
    return [...this.orders.values()].filter((o) => symbol === undefined || o.symbol === symbol).map((o) => ({ ...o }))
  }

  // Candidatas a disparar en un tick: primero los stops y después los take profit,
  // así un tick que cruzara los dos resuelve el extremo adverso (peor caso, spec §6).
  triggerOrder(symbol: string): Order[] {
    const orders = this.list(symbol)
    return [...orders.filter((o) => o.type === 'STOP_MARKET'), ...orders.filter((o) => o.type === 'TAKE_PROFIT_MARKET')]
  }
}
