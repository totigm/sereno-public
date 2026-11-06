// Cancelaciones de algos del bot que Binance no tomó (un stop viejo, el hermano de una
// posición cerrada): se reintentan, pero con espera creciente. El motor vuelve a pedir la
// cancelación de un stop viejo con cada tick, y sin espera eso sería un pedido por segundo
// contra un Binance que está fallando.

const BASE_MS = 1_000
const MAX_MS = 60_000

interface Pending {
  symbol: string
  failures: number
  // Reloj local desde el que vale volver a intentar.
  nextAt: number
}

export class CancelBackoff {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly now: () => number) {}

  // Para cancelar más tarde, sin haber fallado todavía (los hermanos de un disparo).
  add(clientAlgoId: string, symbol: string): void {
    if (!this.pending.has(clientAlgoId)) this.pending.set(clientAlgoId, { symbol, failures: 0, nextAt: this.now() })
  }

  failed(clientAlgoId: string, symbol: string): void {
    const failures = (this.pending.get(clientAlgoId)?.failures ?? 0) + 1
    this.pending.set(clientAlgoId, { symbol, failures, nextAt: this.now() + Math.min(MAX_MS, BASE_MS * 2 ** (failures - 1)) })
  }

  done(clientAlgoId: string): void {
    this.pending.delete(clientAlgoId)
  }

  // Milisegundos que faltan para poder reintentar; 0 si se puede ya (o nunca falló).
  waitFor(clientAlgoId: string): number {
    const p = this.pending.get(clientAlgoId)
    return p ? Math.max(0, p.nextAt - this.now()) : 0
  }

  due(): { clientAlgoId: string; symbol: string }[] {
    const now = this.now()
    return [...this.pending].filter(([, p]) => p.nextAt <= now).map(([clientAlgoId, p]) => ({ clientAlgoId, symbol: p.symbol }))
  }

  all(): { clientAlgoId: string; symbol: string }[] {
    return [...this.pending].map(([clientAlgoId, p]) => ({ clientAlgoId, symbol: p.symbol }))
  }
}
