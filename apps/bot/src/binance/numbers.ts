// Los números de Binance llegan como string (a veces como número): se convierten acá y
// un valor que no es un número finito corta en vez de colarse como NaN.

export function num(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`Binance: número inválido "${value}"`)
  return n
}
