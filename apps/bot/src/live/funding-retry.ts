// Funding que el motor no pudo cobrar porque la liquidación llegó inválida (una marca
// vacía en el historial de REST, que se lee como 0, o una tasa que no es un número). No
// se da por cobrado: se reintenta con la marca de los próximos ticks válidos de la moneda
// (lo mismo que hace el stream, que liquida con "la marca de ahora") hasta
// `MAX_FUNDING_ATTEMPTS` intentos en total; después se abandona y se avisa.

import type { FundingEvent, MarkTick, Position } from '@sereno/core'

export const MAX_FUNDING_ATTEMPTS = 3

interface Pending {
  event: FundingEvent
  attempts: number
}

export interface FundingRetry {
  // La liquidación con la marca del tick, lista para volver a cobrarla.
  event: FundingEvent
  // El último intento posible: si vuelve a fallar, se abandona.
  last: boolean
}

export class FundingRetries {
  private readonly pending = new Map<string, Pending>()

  // Un intento que falló (el primero o un reintento).
  failed(event: FundingEvent): void {
    const key = keyOf(event)
    const attempts = (this.pending.get(key)?.attempts ?? 0) + 1
    if (attempts >= MAX_FUNDING_ATTEMPTS) this.pending.delete(key)
    else this.pending.set(key, { event, attempts })
  }

  // Se cobró (por un reintento o porque la misma liquidación llegó bien por otro camino).
  charged(event: FundingEvent): void {
    this.pending.delete(keyOf(event))
  }

  has(symbol: string): boolean {
    for (const { event } of this.pending.values()) if (event.symbol === symbol) return true
    return false
  }

  // Los reintentos de la moneda del tick, con su marca. Se descartan los que ya no tienen a
  // quién cobrarle: sin abierta en la moneda, o con una abierta posterior a la liquidación
  // (la que la debía ya cerró y el simulador se la cobraría a otra).
  take(tick: MarkTick, open: readonly Position[]): FundingRetry[] {
    if (!(tick.markPrice > 0)) return []
    const owing = open.filter((p) => p.symbol === tick.symbol)
    const retries: FundingRetry[] = []
    for (const [key, { event, attempts }] of this.pending) {
      if (event.symbol !== tick.symbol) continue
      if (owing.length > 0 && owing.every((p) => p.openedAt < event.at)) {
        retries.push({ event: { ...event, markPrice: tick.markPrice }, last: attempts + 1 >= MAX_FUNDING_ATTEMPTS })
      } else {
        this.pending.delete(key)
      }
    }
    return retries.sort((a, b) => a.event.at - b.event.at)
  }
}

function keyOf(event: FundingEvent): string {
  return `${event.symbol}:${event.at}`
}
