// Nombre de la moneda tal como lo lee Toti: "SOLUSDT" → "SOL", "1000PEPEUSDT" → "PEPE".
// Position guarda el símbolo del contrato y no el activo base, así que se recorta la moneda
// de cotización (en USDⓈ-M sólo quedan USDT y USDC) y el prefijo multiplicador de Binance.
// Es el ÚNICO nombre visible: diario, learning_log y todas las pantallas lo usan.
const QUOTE_ASSETS = ['USDT', 'USDC'] as const

// Sólo cuenta como prefijo si lo siguen letras: "1INCH" es el nombre de la moneda.
const MULTIPLIER_PREFIX = /^(?:1000000|10000|1000|1M)(?=[A-Z])/

const CONTRACT_SYMBOL = /\b[A-Z0-9]+(?:USDT|USDC)\b/g

export function coinName(symbol: string): string {
  return withoutQuote(symbol).replace(MULTIPLIER_PREFIX, '')
}

function withoutQuote(symbol: string): string {
  for (const quote of QUOTE_ASSETS) {
    if (symbol.length > quote.length && symbol.endsWith(quote)) return symbol.slice(0, -quote.length)
  }
  return symbol
}

// Reemplaza los símbolos de contrato que aparezcan en un texto libre; cifras y palabras
// que no terminan en una moneda de cotización quedan como están.
export function withCoinNames(text: string): string {
  return text.replace(CONTRACT_SYMBOL, coinName)
}
