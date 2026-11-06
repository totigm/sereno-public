import { formatLeverage, formatUsdRound } from '@sereno/core/src/journal/format'
import { formatNumber, formatPct } from '@/lib/format'

// Cómo se escribe y se lee cada número de los ajustes. Los porcentajes se guardan
// como fracción (0,02) y se editan en puntos (2): la conversión vive acá y en ningún otro lado.

export type Unit = 'pct' | 'usd' | 'leverage' | 'count' | 'hours' | 'multiple'

/** Lo que va pegado al valor dentro del campo. */
export const AFFIX: Record<Unit, { prefix?: string; suffix?: string }> = {
  pct: { suffix: '%' },
  usd: { prefix: 'US$' },
  leverage: { suffix: 'x' },
  count: {},
  hours: { suffix: 'h' },
  multiple: { suffix: 'veces' },
}

// Doce cifras significativas alcanzan para cualquier ajuste y borran el residuo
// binario de multiplicar o dividir por 100 (0,07 × 100 = 7,000000000000001).
const clean = (n: number): number => Number(n.toPrecision(12))

const toShown = (value: number, unit: Unit): number => (unit === 'pct' ? clean(value * 100) : value)

/** El texto del campo: `0.0005` en `pct` es `"0,05"`. */
export function toInput(value: number, unit: Unit): string {
  return String(toShown(value, unit)).replace('.', ',')
}

const NUMBER = /^\d+(?:[.,]\d+)?$/

/** Lo escrito (coma o punto decimal) en la unidad guardada; null si no es un número. */
export function parseInput(text: string, unit: Unit): number | null {
  const trimmed = text.trim()
  if (!NUMBER.test(trimmed)) return null
  const n = Number(trimmed.replace(',', '.'))
  return unit === 'pct' ? clean(n / 100) : n
}

/** Porcentaje con los decimales que tenga (hasta tres): 0,05%, 2,5%, 70%. */
export function formatPctTrim(fraction: number, sign = false): string {
  const points = clean(fraction * 100)
  const decimals = [0, 1, 2, 3].find((d) => Math.abs(Number(points.toFixed(d)) - points) < 1e-9) ?? 3
  return formatPct(fraction, decimals, sign)
}

/** Cómo se lee el valor en la pantalla (sólo lectura, mensajes, toasts). */
export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case 'pct':
      return formatPctTrim(value)
    case 'usd':
      return formatUsdRound(value)
    case 'leverage':
      return formatLeverage(value)
    case 'hours':
      return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} h`
    case 'multiple':
      return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} veces el capital`
    case 'count':
      return formatNumber(value, 0)
  }
}

/** Un monto con signo explícito: "+US$ 10", "−US$ 5". */
export function formatUsdSigned(n: number): string {
  return n < 0 ? formatUsdRound(n) : `+${formatUsdRound(n)}`
}
