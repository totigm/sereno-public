// Leer un monto como lo escribe alguien de acá. Lo usan los formularios (primer uso,
// plata real) y las acciones que comparan lo escrito con un monto (la confirmación de
// la plata real), así el navegador y el servidor lo entienden igual.

const MAX_CAPITAL = 1e9
const THOUSANDS = /^\d{1,3}(?:\.\d{3})+$/

/**
 * "1000", "1.000", "1.000,50", "1000.5", "US$ 2.500" → el número; null si no es un monto
 * positivo. Con coma, los puntos son de miles; sin coma, un punto con tres cifras detrás
 * también (así "1.000" es mil y no uno).
 */
export function parseCapital(text: string): number | null {
  const raw = text.replace(/US\$|\s/g, '')
  if (raw === '') return null
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : THOUSANDS.test(raw) ? raw.replace(/\./g, '') : raw
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null
  const n = Number(normalized)
  return Number.isFinite(n) && n > 0 && n <= MAX_CAPITAL ? n : null
}
