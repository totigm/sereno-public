// Firma de los pedidos `USER_DATA` de Binance: HMAC-SHA256, en hexadecimal, del query
// string tal cual viaja, con el secret de la clave. El secret no sale de acá y la firma
// no aparece en un log ni en un error (`redactSignature`).

import { createHmac } from 'node:crypto'

// Cuánto acepta Binance entre el `timestamp` del pedido y su reloj.
export const RECV_WINDOW_MS = 5_000

export function signQuery(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex')
}

export function redactSignature(text: string): string {
  return text.replace(/signature=[^&\s"']*/gi, 'signature=[redactada]')
}
