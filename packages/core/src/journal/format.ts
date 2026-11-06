import { formatNumber, formatPct, formatSigned, formatUsd, MINUS } from '@sereno/shared'

// Formatos propios del diario, encima de los de `@sereno/shared`.

// Montos "redondos" (margen, capital, objetivos de blindaje) se leen sin centavos
// cuando no los tienen: "US$ 50", "US$ 1.000"; con centavos, "US$ 37,50". Los
// resultados (pnl) siempre van con `formatUsd`, con sus dos decimales.
export function formatUsdRound(n: number): string {
  const cents = Math.round(n * 100)
  if (cents % 100 !== 0) return formatUsd(n)
  return `${cents < 0 ? MINUS : ''}US$ ${formatNumber(Math.abs(cents) / 100, 0)}`
}

// "Tu capital" (spec §11.1): montos a dólar entero, "US$ 695", "US$ 1.005". Los centavos
// sólo quedan por debajo de US$ 10, donde todavía dicen algo. Con `ceil`, el entero de
// arriba: lo que falta para blindar no promete menos de lo que falta.
export function formatUsdWhole(n: number, mode: 'round' | 'ceil' = 'round'): string {
  const cents = Math.round(n * 100)
  if (Math.abs(cents) < 1000) return formatUsdRound(cents / 100)
  const whole = mode === 'ceil' ? Math.ceil(cents / 100) : Math.round(cents / 100)
  return `${whole < 0 ? MINUS : ''}US$ ${formatNumber(Math.abs(whole), 0)}`
}

// Lo mismo para porcentajes de ajustes: "3%", "2,5%".
export function formatPctRound(fraction: number): string {
  const tenths = Math.round(fraction * 1000)
  return formatPct(fraction, tenths % 10 === 0 ? 0 : 1, false)
}

// Resultado de una operación: "+US$ 12,40", "−US$ 6,20", "US$ 0,00".
export function formatPnl(n: number): string {
  return formatUsd(n, { sign: true })
}

// Múltiplo de R con un decimal: "+2,0R", "−1,0R", "0,0R".
export function formatR(r: number): string {
  return `${formatSigned(r, 1)}R`
}

// Precio con al menos cuatro cifras significativas (y como mínimo dos decimales),
// sin ceros de relleno más allá del segundo decimal: 142,10 · 20,10 · 0,0000118.
// Position no guarda el tick del contrato, así que se infiere del orden de magnitud.
const MAX_PRICE_DECIMALS = 8

function priceDecimals(n: number): number {
  const magnitude = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)))
  return Math.min(MAX_PRICE_DECIMALS, Math.max(2, 3 - magnitude))
}

function priceAt(n: number, decimals: number): string {
  return formatNumber(n, decimals).replace(/(,\d{2}\d*?)0+$/, '$1')
}

export function formatPrice(n: number): string {
  return priceAt(n, priceDecimals(n))
}

// Dos precios que tienen que leerse distintos ("de 3,4561 a 3,4564"): se suman
// decimales hasta que se diferencien.
export function formatPriceRange(from: number, to: number): [string, string] {
  let decimals = Math.max(priceDecimals(from), priceDecimals(to))
  while (decimals < MAX_PRICE_DECIMALS && from !== to && priceAt(from, decimals) === priceAt(to, decimals)) decimals++
  return [priceAt(from, decimals), priceAt(to, decimals)]
}

export function formatLeverage(leverage: number): string {
  return `${String(leverage).replace('.', ',')}x`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
