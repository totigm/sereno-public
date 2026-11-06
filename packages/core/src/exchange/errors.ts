// Rechazo de una orden a mercado por una regla del exchange: no se abrió nada y es una
// respuesta esperable (en Binance, −4164 nocional mínimo y −2019 margen insuficiente).
// Un exchange real suma los suyos: la operación real apagada (sólo reduce riesgo), una
// posición que no es del bot en esa moneda y cualquier otro rechazo de Binance.
// Cualquier otro error (símbolo desconocido, sin precio, cantidad inválida) es una falla.
export type OrderRejectReason = 'min_notional' | 'insufficient_margin' | 'opening_disabled' | 'foreign_position' | 'exchange_rejected'

export class OrderRejectedError extends Error {
  readonly reason: OrderRejectReason
  // La frase del rechazo para el diario, si el exchange la tiene (la de Binance, traducida).
  readonly detail?: string

  constructor(reason: OrderRejectReason, message: string, detail?: string) {
    super(message)
    this.name = 'OrderRejectedError'
    this.reason = reason
    if (detail !== undefined) this.detail = detail
  }
}
