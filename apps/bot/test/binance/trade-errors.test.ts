import { describe, expect, it } from 'vitest'
import { BinanceGeoBlocked, BinanceHttpError, BinanceNetworkError, BinanceRateLimited } from '../../src/binance/errors'
import { classifyBinanceError, isUnknownOutcome } from '../../src/binance/trade-errors'

const PATH = '/fapi/v1/order'

function httpError(code: number | null, status = 400, msg = 'Binance dijo algo'): BinanceHttpError {
  return new BinanceHttpError(`${msg} (HTTP ${status} ${PATH})`, { status, code, path: PATH })
}

describe('classifyBinanceError', () => {
  const rows: [label: string, err: unknown, kind: 'retryable' | 'rejected' | 'fatal', code: number | null, message: RegExp][] = [
    ['red caída', new BinanceNetworkError('Binance: falló la red en /fapi/v1/order', PATH), 'retryable', null, /^Binance no respondió/],
    ['HTTP 503', httpError(-1000, 503), 'retryable', -1000, /^Binance tuvo un error interno \(HTTP 503\)/],
    ['HTTP 429', new BinanceRateLimited('x', { status: 429, code: -1003, path: PATH, retryAfterMs: null }), 'retryable', -1003, /^Binance frena los pedidos por exceso/],
    ['HTTP 418', new BinanceRateLimited('x', { status: 418, code: null, path: PATH, retryAfterMs: 120_000 }), 'retryable', null, /^Binance frena los pedidos por exceso/],
    ['−1001', httpError(-1001, 503), 'retryable', -1001, /^Binance se desconectó internamente/],
    ['−1007', httpError(-1007, 408), 'retryable', -1007, /^Binance no confirmó a tiempo/],
    ['−1015', httpError(-1015), 'retryable', -1015, /^Binance: demasiadas órdenes nuevas/],
    ['−1021', httpError(-1021), 'retryable', -1021, /^La hora de este equipo está corrida/],
    ['−2019', httpError(-2019), 'rejected', -2019, /^Binance rechazó la orden: no alcanza el margen$/],
    ['−4164', httpError(-4164), 'rejected', -4164, /^Binance rechazó la orden: el nocional es menor que el mínimo$/],
    ['−2021', httpError(-2021), 'rejected', -2021, /^Binance rechazó la orden: dispararía en el acto$/],
    ['−2022', httpError(-2022), 'rejected', -2022, /^Binance rechazó la orden de sólo reducir: no hay posición que reducir$/],
    ['−1111', httpError(-1111), 'rejected', -1111, /^Binance rechazó la orden: más decimales que los del contrato$/],
    ['−4003', httpError(-4003), 'rejected', -4003, /^Binance rechazó la orden: cantidad menor o igual a cero$/],
    ['−4005', httpError(-4005), 'rejected', -4005, /^Binance rechazó la orden: cantidad mayor que la máxima$/],
    ['−4131', httpError(-4131), 'rejected', -4131, /^Binance rechazó la orden: el mejor precio del libro está fuera del rango permitido$/],
    ['−2010', httpError(-2010), 'rejected', -2010, /^Binance rechazó la orden: no alcanza el saldo$/],
    ['−2018', httpError(-2018), 'rejected', -2018, /^Binance rechazó la orden: no alcanza el saldo$/],
    ['−2015', httpError(-2015, 401), 'fatal', -2015, /^Binance rechaza la clave: inválida, IP no autorizada o sin permiso$/],
    ['−2014', httpError(-2014), 'fatal', -2014, /^Binance rechaza la clave: formato inválido$/],
    ['−1022', httpError(-1022), 'fatal', -1022, /^Binance rechaza la firma del pedido$/],
    ['HTTP 401 sin código', httpError(null, 401), 'fatal', null, /^Binance rechaza la clave \(HTTP 401\)$/],
    ['HTTP 451', new BinanceGeoBlocked('x', { status: 451, code: null, path: PATH }), 'fatal', null, /^Binance bloquea la IP de este equipo$/],
    ['−4061', httpError(-4061), 'fatal', -4061, /^La cuenta está en modo cobertura/],
    ['−4120', httpError(-4120), 'fatal', -4120, /^Orden condicional mandada al endpoint equivocado/],
  ]

  for (const [label, err, kind, code, message] of rows) {
    it(`${label} → ${kind}`, () => {
      const classified = classifyBinanceError(err)
      expect(classified.kind).toBe(kind)
      expect(classified.code).toBe(code)
      expect(classified.message).toMatch(message)
    })
  }

  it('un rechazo de Binance que no está en la tabla queda como rechazo, con el código y sin el texto en inglés', () => {
    const classified = classifyBinanceError(httpError(-4140, 400, 'Invalid symbol status for opening position'))
    expect(classified).toEqual({ kind: 'rejected', code: -4140, message: 'Binance rechazó el pedido (código −4140)' })
  })

  it('un 5xx sin código sigue siendo reintentable', () => {
    expect(classifyBinanceError(httpError(null, 502)).kind).toBe('retryable')
  })

  it('un error que no es de Binance es fatal (es un bug) y no deja pasar una firma', () => {
    const classified = classifyBinanceError(new TypeError('falló https://x/fapi/v1/order?symbol=BTCUSDT&signature=abc123'))
    expect(classified.kind).toBe('fatal')
    expect(classified.code).toBeNull()
    expect(classified.message).toMatch(/^Error inesperado del cliente de Binance/)
    expect(classified.message).not.toContain('abc123')
  })
})

describe('isUnknownOutcome', () => {
  it('red caída, timeout, 5xx y −1007/−1006: Binance puede haber ejecutado la orden', () => {
    expect(isUnknownOutcome(new BinanceNetworkError('x', PATH))).toBe(true)
    expect(isUnknownOutcome(httpError(-1000, 503))).toBe(true)
    expect(isUnknownOutcome(httpError(null, 500))).toBe(true)
    expect(isUnknownOutcome(httpError(-1007, 408))).toBe(true)
    expect(isUnknownOutcome(httpError(-1006, 400))).toBe(true)
  })

  it('las fallas que Binance garantiza sin ejecutar no se consultan', () => {
    // Documentación: −1001 y −1008 son fallas seguras; "Service Unavailable." también.
    expect(isUnknownOutcome(httpError(-1001, 503))).toBe(false)
    expect(isUnknownOutcome(httpError(-1008, 503))).toBe(false)
    expect(isUnknownOutcome(httpError(null, 503, 'Service Unavailable.'))).toBe(false)
    expect(isUnknownOutcome(httpError(-2019))).toBe(false)
    expect(isUnknownOutcome(new BinanceRateLimited('x', { status: 429, code: -1003, path: PATH, retryAfterMs: null }))).toBe(false)
  })
})
