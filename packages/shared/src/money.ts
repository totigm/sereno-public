// Formato de números y montos en es-AR: punto de miles, coma decimal y el
// signo menos tipográfico (U+2212) en lugar del guion que devuelve Intl.

export const MINUS = '−'

/** Lo que se muestra en lugar de un número no finito (NaN, ±Infinity): raya U+2014. */
export const EM_DASH = '—'

const LOCALE = 'es-AR'

type Sign = -1 | 0 | 1

/** Un número formateado sin signo, más el signo que corresponde al valor ya redondeado. */
interface SignedText {
  sign: Sign
  body: string
}

const formatters = new Map<string, Intl.NumberFormat>()

function formatter(minDecimals: number, maxDecimals: number, percent: boolean): Intl.NumberFormat {
  const key = `${minDecimals}:${maxDecimals}:${percent}`
  let nf = formatters.get(key)
  if (!nf) {
    nf = new Intl.NumberFormat(LOCALE, {
      style: percent ? 'percent' : 'decimal',
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
      // exceptZero decide el signo sobre el valor redondeado: -0,001 no termina en "−0,00".
      signDisplay: 'exceptZero',
    })
    formatters.set(key, nf)
  }
  return nf
}

function toSignedText(n: number, minDecimals: number, maxDecimals = minDecimals, percent = false): SignedText {
  let sign: Sign = 0
  let body = ''
  for (const part of formatter(minDecimals, maxDecimals, percent).formatToParts(n)) {
    if (part.type === 'minusSign') sign = -1
    else if (part.type === 'plusSign') sign = 1
    // Algunas versiones de ICU separan el % con un espacio duro; el diseño lo quiere pegado.
    else if (!(percent && part.type === 'literal' && part.value.trim() === '')) body += part.value
  }
  return { sign, body }
}

const THOUSAND = { size: 1e3, suffix: 'k' }
const MILLION = { size: 1e6, suffix: 'M' }

const plainFormatters = new Map<number, Intl.NumberFormat>()

// Redondea igual que el cuerpo (Intl, decimal y half-expand), no con Math.round
// binario: así el umbral y el texto nunca discrepan en bordes como x99,95.
function roundLikeBody(n: number, maxDecimals: number): number {
  let nf = plainFormatters.get(maxDecimals)
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: maxDecimals })
    plainFormatters.set(maxDecimals, nf)
  }
  return Number(nf.format(n))
}

// Abrevia desde mil; elige la unidad mirando el valor ya redondeado para que
// 999.960 diga "1 M" y no "1.000 k". Más allá del millón sigue en M (no hay
// montos de ese orden en la app y "mil millones" se lee peor que "1.200 M").
function toCompactText(n: number): SignedText {
  const abs = Math.abs(n)
  if (roundLikeBody(abs, 2) < 1000) return toSignedText(n, 2)
  const unit = roundLikeBody(abs / THOUSAND.size, 1) < 1000 ? THOUSAND : MILLION
  return { sign: n < 0 ? -1 : 1, body: `${toSignedText(abs / unit.size, 0, 1).body} ${unit.suffix}` }
}

const signPrefix = (sign: Sign, showPlus: boolean): string => (sign < 0 ? MINUS : sign > 0 && showPlus ? '+' : '')

/** `1247.8` → `"1.247,80"`; negativos con U+2212. Lo no finito es `EM_DASH` en todas las funciones. */
export function formatNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return EM_DASH
  const { sign, body } = toSignedText(n, decimals)
  return signPrefix(sign, false) + body
}

/** Siempre con signo salvo el cero: `"+3,10"`, `"−3,10"`, `"0,00"`. */
export function formatSigned(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return EM_DASH
  const { sign, body } = toSignedText(n, decimals)
  return signPrefix(sign, true) + body
}

/**
 * `"US$ 1.247,80"`. Los negativos siempre llevan U+2212 delante del prefijo;
 * `sign` agrega además el `+` a los positivos. `compact` abrevia desde mil (`"US$ 1,2 k"`).
 */
export function formatUsd(n: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return EM_DASH
  const { sign, body } = opts.compact ? toCompactText(n) : toSignedText(n, 2)
  return `${signPrefix(sign, opts.sign ?? false)}US$ ${body}`
}

/** Recibe una fracción: `0.248` → `"+24,8%"`. Los negativos siempre llevan U+2212. */
export function formatPct(n: number, decimals = 1, sign = true): string {
  if (!Number.isFinite(n)) return EM_DASH
  const text = toSignedText(n, decimals, decimals, true)
  return signPrefix(text.sign, sign) + text.body
}
