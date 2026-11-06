// Reintentos de los pedidos de la sesión real que se pueden repetir: stops y take profits
// (Binance rechaza un id algorítmico repetido mientras está puesto) y el margen y el
// apalancamiento. Cada intento sale después de su espera (`delaysMs[i]`) y sólo se reintenta
// lo que Binance da por reintentable. Una orden de mercado con el mismo id nunca pasa por
// acá: una que Binance llena tarde ya no es una orden abierta y otra con el mismo id la
// duplicaría (cabecera de `trade-rest.ts`). Sí se reenvía, con otro id, una que Binance dice
// que no ejecutó (`isSafeToResend`).

import { classifyBinanceError, isUnknownOutcome } from '../binance/trade-errors'
import type { Clock } from '../live/timers'

export interface RetryPolicy {
  // Espera antes de cada intento: tantos intentos como esperas.
  delaysMs: readonly number[]
  // Cuánto se espera el fill de una orden (o el disparo de un stop) antes de preguntar por REST.
  fillTimeoutMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { delaysMs: [0, 500, 1_500], fillTimeoutMs: 3_000 }

// Sin espera no hay temporizador: el intento sale en el acto.
export function wait(clock: Clock, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    clock.timers.setTimeout(resolve, ms)
  })
}

export function isRetryable(err: unknown): boolean {
  return classifyBinanceError(err).kind === 'retryable'
}

// Una falla reintentable cuyo resultado se sabe: Binance no ejecutó el pedido (−1001, −1008,
// un 429, un 503 "Service Unavailable"). Reenviarlo con otro id no puede duplicar nada.
export function isSafeToResend(err: unknown): boolean {
  return isRetryable(err) && !isUnknownOutcome(err)
}

export async function withRetries<T>(clock: Clock, delaysMs: readonly number[], send: () => Promise<T>, canRetry: (err: unknown) => boolean = isRetryable): Promise<T> {
  if (delaysMs.length === 0) throw new RangeError('withRetries: hace falta al menos un intento')
  let last: unknown
  for (const delay of delaysMs) {
    await wait(clock, delay)
    try {
      return await send()
    } catch (err) {
      if (!canRetry(err)) throw err
      last = err
    }
  }
  throw last
}
