import { describe, expect, it } from 'vitest'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../../src/binance/errors'
import { replayFailureMessage } from '../../src/replay/failure'
import { WorkerExited } from '../../src/replay/worker'

const http = (status: number) => ({ status, code: null, path: '/fapi/v1/klines' })

describe('replayFailureMessage', () => {
  it('dice en castellano qué pasó según la clase del error, sin el texto técnico', () => {
    expect(replayFailureMessage(new BinanceHttpError('Service Unavailable', http(503)))).toBe(
      'Falló: Binance no respondió bien mientras bajaba los datos. Probá de nuevo más tarde.',
    )
    expect(replayFailureMessage(new BinanceHttpError('Unauthorized', http(401)))).toBe('Falló: Binance rechazó un pedido de datos (error 401).')
    expect(replayFailureMessage(new BinanceGeoBlocked('Service unavailable from a restricted location', http(451)))).toBe(
      'Falló: Binance no deja bajar datos desde esta conexión (bloqueo por ubicación).',
    )
    expect(replayFailureMessage(new BinanceRateLimited('Too many requests', { ...http(429), retryAfterMs: 60_000 }))).toBe(
      'Falló: Binance frenó los pedidos por exceso de llamadas. Probá de nuevo en unos minutos.',
    )
    expect(replayFailureMessage(new BinanceNetworkError('Binance: fetch failed en /fapi/v1/klines', '/fapi/v1/klines'))).toBe(
      'Falló: no pude conectarme con Binance. Revisá la conexión y pedilo de nuevo.',
    )
    expect(replayFailureMessage(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe(
      'Falló: no pude leer o escribir en la base de datos. Probá de nuevo en un rato.',
    )
    expect(replayFailureMessage(new WorkerExited(1))).toBe('Falló: el proceso que corría el replay se cortó sin terminar.')
  })

  it('cualquier otro error queda con una frase general: el detalle va al log del bot', () => {
    expect(replayFailureMessage(new Error('replay: XUSDT entró al universo y no está en la tabla de contratos'))).toBe(
      'Falló por un error inesperado. El detalle quedó en el log del bot.',
    )
    expect(replayFailureMessage('texto')).toBe('Falló por un error inesperado. El detalle quedó en el log del bot.')
  })
})
