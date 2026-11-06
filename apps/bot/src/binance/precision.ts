// Cantidades y precios como los acepta Binance: múltiplos exactos de `stepSize`/`tickSize`,
// redondeados hacia abajo y escritos en decimal (nunca `1e-7`, que Binance rechaza).

// Tolerancia, en pasos de la grilla, contra el ruido de la coma flotante: 0.3 / 0.1 da
// 2.9999999999999996 y sin ella se perdería un paso entero.
const GRID_EPSILON = 1e-7

export function formatQty(qty: number, stepSize: number): string {
  return floorToGrid(qty, stepSize, 'cantidad')
}

export function formatPrice(price: number, tickSize: number): string {
  return floorToGrid(price, tickSize, 'precio')
}

function floorToGrid(value: number, step: number, what: string): string {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError(`Binance: grilla inválida ${step} para la ${what}`)
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Binance: ${what} inválida ${value}`)
  const units = Math.floor(value / step + GRID_EPSILON)
  return (units * step).toFixed(decimalsOf(step))
}

// Decimales de la grilla: '0.001' → 3, 1e-8 → 8, '0.25' → 2, '10' → 0.
function decimalsOf(step: number): number {
  const [mantissa = '', exponent] = step.toString().toLowerCase().split('e')
  const fraction = mantissa.split('.')[1]?.length ?? 0
  return Math.max(0, fraction - Number(exponent ?? 0))
}
