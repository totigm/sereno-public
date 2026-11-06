import { BinanceHttpError } from '../binance/errors'

// Un símbolo que no pudo traerse; el runtime lo marca degradado.
export interface SymbolFailure {
  symbol: string
  error: string
}

// Un 400 (parámetros de ese pedido: símbolo inválido, sin datos) es problema de ese
// símbolo: el job lo anota y sigue. El resto es de todos y corta el job: 401/403 (clave
// o bloqueo de IP o WAF), 404 (ruta equivocada), 451, 429/418, 5xx o red caída tras los
// reintentos. Insistir con cada símbolo sólo gasta pedidos o empeora el castigo.
export function isSymbolScoped(err: unknown): boolean {
  return err instanceof BinanceHttpError && err.status === 400
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
