// Qué hacer con un error de Binance al operar: reintentar (`retryable`), contarlo como un
// rechazo de esa orden (`rejected`, va al diario) o apagar la sesión real (`fatal`: la clave,
// la IP, el modo de la cuenta o un bug nuestro). El mensaje sale en castellano y nunca
// arrastra el texto crudo del pedido: ahí podría viajar una firma.
// Códigos verificados en la documentación (cabecera de `trade-types.ts`).

import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from './errors'
import { redactSignature } from './signing'

export type BinanceErrorKind = 'retryable' | 'rejected' | 'fatal'

export interface ClassifiedError {
  kind: BinanceErrorKind
  code: number | null
  message: string
}

const BY_CODE: ReadonlyMap<number, { kind: BinanceErrorKind; message: string }> = new Map([
  [-1001, { kind: 'retryable', message: 'Binance se desconectó internamente; se puede reintentar' }],
  [-1003, { kind: 'retryable', message: 'Binance frena los pedidos por exceso; hay que esperar' }],
  [-1006, { kind: 'retryable', message: 'Binance no confirmó a tiempo; el resultado es desconocido' }],
  [-1007, { kind: 'retryable', message: 'Binance no confirmó a tiempo; el resultado es desconocido' }],
  [-1008, { kind: 'retryable', message: 'Binance está sobrecargado; se puede reintentar' }],
  [-1015, { kind: 'retryable', message: 'Binance: demasiadas órdenes nuevas; hay que esperar' }],
  [-1021, { kind: 'retryable', message: 'La hora de este equipo está corrida respecto de la de Binance' }],
  [-2019, { kind: 'rejected', message: 'Binance rechazó la orden: no alcanza el margen' }],
  [-4164, { kind: 'rejected', message: 'Binance rechazó la orden: el nocional es menor que el mínimo' }],
  [-2021, { kind: 'rejected', message: 'Binance rechazó la orden: dispararía en el acto' }],
  [-2022, { kind: 'rejected', message: 'Binance rechazó la orden de sólo reducir: no hay posición que reducir' }],
  [-1111, { kind: 'rejected', message: 'Binance rechazó la orden: más decimales que los del contrato' }],
  [-4003, { kind: 'rejected', message: 'Binance rechazó la orden: cantidad menor o igual a cero' }],
  [-4005, { kind: 'rejected', message: 'Binance rechazó la orden: cantidad mayor que la máxima' }],
  [-4131, { kind: 'rejected', message: 'Binance rechazó la orden: el mejor precio del libro está fuera del rango permitido' }],
  [-2010, { kind: 'rejected', message: 'Binance rechazó la orden: no alcanza el saldo' }],
  [-2018, { kind: 'rejected', message: 'Binance rechazó la orden: no alcanza el saldo' }],
  [-2015, { kind: 'fatal', message: 'Binance rechaza la clave: inválida, IP no autorizada o sin permiso' }],
  [-2014, { kind: 'fatal', message: 'Binance rechaza la clave: formato inválido' }],
  [-1022, { kind: 'fatal', message: 'Binance rechaza la firma del pedido' }],
  [-4061, { kind: 'fatal', message: 'La cuenta está en modo cobertura; Sereno opera sólo con una posición por moneda' }],
  [-4120, { kind: 'fatal', message: 'Orden condicional mandada al endpoint equivocado (error del bot)' }],
])

export function classifyBinanceError(err: unknown): ClassifiedError {
  if (err instanceof BinanceNetworkError) return { kind: 'retryable', code: null, message: 'Binance no respondió (falló la red o venció el plazo); se puede reintentar' }
  if (err instanceof BinanceGeoBlocked) return { kind: 'fatal', code: err.code, message: 'Binance bloquea la IP de este equipo' }
  if (err instanceof BinanceRateLimited) return { kind: 'retryable', code: err.code, message: `Binance frena los pedidos por exceso (HTTP ${err.status}); hay que esperar` }
  if (err instanceof BinanceHttpError) {
    const known = err.code === null ? undefined : BY_CODE.get(err.code)
    if (known) return { kind: known.kind, code: err.code, message: known.message }
    if (err.status === 401) return { kind: 'fatal', code: err.code, message: 'Binance rechaza la clave (HTTP 401)' }
    if (err.status >= 500) return { kind: 'retryable', code: err.code, message: `Binance tuvo un error interno (HTTP ${err.status}); se puede reintentar` }
    const code = err.code === null ? `HTTP ${err.status}` : `código ${signed(err.code)}`
    return { kind: 'rejected', code: err.code, message: `Binance rechazó el pedido (${code})` }
  }
  const detail = redactSignature(err instanceof Error ? err.message : String(err)).replace(/\?\S*/g, '')
  return { kind: 'fatal', code: null, message: `Error inesperado del cliente de Binance: ${detail}` }
}

// Fallas que Binance documenta como seguras: el pedido no se ejecutó y se puede reenviar.
const DEFINITE_FAILURE_CODES: ReadonlySet<number> = new Set([-1001, -1008])
// Fallas con el resultado desconocido: la orden pudo haber entrado.
const UNKNOWN_OUTCOME_CODES: ReadonlySet<number> = new Set([-1006, -1007])

// ¿Binance pudo haber ejecutado el pedido aunque contestó error (o no contestó)? Para una
// orden nueva eso obliga a consultar por id de cliente antes de mandarla otra vez.
export function isUnknownOutcome(err: unknown): boolean {
  if (err instanceof BinanceNetworkError) return true
  // Un 429/418 (`BinanceRateLimited`) o un 451 son rechazos en la puerta: no se ejecutó nada.
  if (!(err instanceof BinanceHttpError)) return false
  if (err.code !== null && DEFINITE_FAILURE_CODES.has(err.code)) return false
  if (err.code !== null && UNKNOWN_OUTCOME_CODES.has(err.code)) return true
  // 503 "Service Unavailable." es una falla segura; el resto de los 5xx y el 408 quedan en duda.
  if (err.status === 503 && err.message.startsWith('Service Unavailable')) return false
  return err.status >= 500 || err.status === 408
}

function signed(code: number): string {
  return code < 0 ? `−${-code}` : String(code)
}
