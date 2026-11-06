// Montos leídos de la pantalla ("+US$ 2,90", "−3,62", "US$ 0,04"), para comparar lo que
// dicen dos lugares distintos. El signo es el de la spec (U+2212) o el guion.

const AMOUNT = /([+−-])?(?:US\$\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})/
const SIGNED = /([+−-])(?:US\$\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})/

/** Espacios duros y saltos de línea como un espacio común. */
export function normalizeText(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function parse(match: RegExpExecArray | null, text: string): number {
  if (!match?.[2]) throw new Error(`No encuentro un monto en "${text}".`)
  const value = Number(match[2].replaceAll('.', '').replace(',', '.'))
  return match[1] === '−' || match[1] === '-' ? -value : value
}

/** El primer monto del texto, con su signo si lo trae. */
export function parseAmount(text: string): number {
  return parse(AMOUNT.exec(text), text)
}

/** El primer monto con signo: el resultado de una fila, no su margen. */
export function parseSignedAmount(text: string): number {
  return parse(SIGNED.exec(text), text)
}
