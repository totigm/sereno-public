import { describe, expect, it } from 'vitest'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../../src/binance/errors'
import { isSymbolScoped } from '../../src/jobs/errors'

const path = '/fapi/v1/klines'

describe('isSymbolScoped', () => {
  it('sólo un 400 (parámetros de ese pedido: símbolo inválido, sin datos) es del símbolo', () => {
    expect(isSymbolScoped(new BinanceHttpError('Invalid symbol.', { status: 400, code: -1121, path }))).toBe(true)
    expect(isSymbolScoped(new BinanceHttpError('Illegal characters found in parameter symbol.', { status: 400, code: -1100, path }))).toBe(true)
  })

  it('401, 403, 404 y el resto de los 4xx son de todos: no se insiste símbolo por símbolo', () => {
    for (const status of [401, 403, 404, 405, 409]) {
      expect(isSymbolScoped(new BinanceHttpError(`HTTP ${status}`, { status, path }))).toBe(false)
    }
  })

  it('bloqueo, límite, 5xx, red caída o un error cualquiera cortan el job', () => {
    expect(isSymbolScoped(new BinanceGeoBlocked('451', { status: 451, path }))).toBe(false)
    expect(isSymbolScoped(new BinanceRateLimited('429', { status: 429, path, retryAfterMs: null }))).toBe(false)
    expect(isSymbolScoped(new BinanceHttpError('HTTP 503', { status: 503, path }))).toBe(false)
    expect(isSymbolScoped(new BinanceNetworkError('ECONNRESET', path))).toBe(false)
    expect(isSymbolScoped(new Error('otra cosa'))).toBe(false)
  })
})
