// Lo que pasa entre la sesión real y Binance y va a `real_events` (el diario lo cuenta):
// rechazos, posiciones ajenas, diferencias, adopciones, cierres sin stop y errores fatales.
// Las frases salen acá para que el adaptador y la reconciliación digan lo mismo.

import type { RealEventKind } from '@sereno/db'
import { BinanceError, BinanceNetworkError } from '../binance/errors'
import { classifyBinanceError } from '../binance/trade-errors'

export type RealNoteKind = Extract<RealEventKind, 'rejected' | 'foreign_position' | 'mismatch' | 'reconciled' | 'adopted' | 'unprotected' | 'fatal'>

export interface RealNote {
  kind: RealNoteKind
  symbol: string | null
  phrase: string
  data?: Record<string, unknown>
}

export type NoteSink = (note: RealNote) => void

export function coinOf(symbol: string): string {
  return symbol.replace(/USDT$/, '')
}

export function foreignPhrase(symbol: string): string {
  return `tenés una posición tuya en ${coinOf(symbol)}; no la toco`
}

export function reconciledPhrase(symbol: string, what: string): string {
  return `Binance y yo no coincidíamos en ${coinOf(symbol)}: ${what}. Lo corregí.`
}

// El cierre que hizo Binance no cerró la cantidad del bot: le faltó o se llevó también lo de
// Toti.
export function closedQtyPhrase(reason: string, symbol: string, filled: number, botQty: number): string {
  const by: Record<string, string> = { take_profit: 'El take profit', liquidation: 'La liquidación', stop: 'El stop' }
  const what = `${by[reason] ?? 'El cierre'} de ${coinOf(symbol)}`
  return filled < botQty ? `${what} cerró ${filled} de ${botQty}.` : `${what} cerró ${filled}, más que los ${botQty} míos: la diferencia era tuya.`
}

// Un error de Binance que apaga la sesión real (clave, IP, modo de la cuenta, comisión en
// otra moneda): se avisa y sale como un `Error` con el mensaje en castellano. Sin `cause`:
// el error original puede arrastrar el pedido firmado. Los demás vuelven tal cual para que
// quien llama decida.
export function fatalOrSame(err: unknown, symbol: string | null, onNote: NoteSink): unknown {
  const classified = classifyBinanceError(err)
  if (classified.kind !== 'fatal') return err
  onNote({ kind: 'fatal', symbol, phrase: classified.message, data: { code: classified.code } })
  return new Error(classified.message)
}

// Un error de un pedido a Binance (lo que se clasifica), no uno nuestro de validación.
export function isBinanceFailure(err: unknown): boolean {
  return err instanceof BinanceError || err instanceof BinanceNetworkError
}
