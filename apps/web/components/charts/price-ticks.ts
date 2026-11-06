import { formatPrice } from '@sereno/core/src/journal/format'
import { formatNumber } from '@/lib/format'

// Las marcas del eje de precios de un gráfico: todas con los mismos decimales, los justos
// para su paso ("75.000", "2.652,5", "0,0000118"). El precio suelto (la etiqueta de la cruz)
// sigue con `formatPrice`.

const MAX_DECIMALS = 8

/** Los decimales que pide el paso entre marcas, más uno para pasos como 2,5 o 0,25. */
function stepDecimals(step: number): number {
  return Math.min(MAX_DECIMALS, Math.max(0, Math.ceil(-Math.log10(step))) + 1)
}

/** ¿Con esos decimales se escribe exacto? Con tolerancia para el ruido de coma flotante. */
function exactAt(price: number, decimals: number): boolean {
  const scaled = price * 10 ** decimals
  return Math.abs(scaled - Math.round(scaled)) < 1e-6
}

export function priceTickLabels(prices: readonly number[]): string[] {
  const sorted = [...prices].sort((a, b) => a - b)
  const step = Math.min(...sorted.slice(1).map((p, i) => p - (sorted[i] ?? p)).filter((d) => d > 0))
  if (!Number.isFinite(step)) return prices.map(formatPrice)
  const max = stepDecimals(step)
  let decimals = 0
  while (decimals < max && !sorted.every((p) => exactAt(p, decimals))) decimals++
  return prices.map((p) => formatNumber(p, decimals))
}
