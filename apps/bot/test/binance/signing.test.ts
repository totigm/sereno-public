import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BinanceHttpError, BinanceNetworkError, isKeyRejected } from '../../src/binance/errors'
import { RECV_WINDOW_MS, redactSignature, signQuery } from '../../src/binance/signing'

// Valores falsos: ningún test usa una clave real.
const SECRET = 'secreto-falso-de-prueba'
const QUERY = 'symbol=BTCUSDT&recvWindow=5000&timestamp=1793491200000'

describe('signQuery', () => {
  it('es el HMAC-SHA256 en hexadecimal del query string con el secret', () => {
    // Vector calculado aparte con node:crypto.
    expect(signQuery(QUERY, SECRET)).toBe('4c23c963e80d6b7433745ac3713adf9da297eccf0aff4799db20575e7532ef8f')
    expect(signQuery(QUERY, SECRET)).toBe(createHmac('sha256', SECRET).update(QUERY).digest('hex'))
  })

  it('cambia con cualquier byte del query', () => {
    expect(signQuery(QUERY.replace('5000', '5001'), SECRET)).not.toBe(signQuery(QUERY, SECRET))
  })

  it('la ventana de recepción es de 5 s', () => {
    expect(RECV_WINDOW_MS).toBe(5_000)
  })
})

describe('redactSignature', () => {
  it('tapa el valor de signature en una URL o un query string', () => {
    const sig = signQuery(QUERY, SECRET)
    const url = `https://fapi.binance.com/fapi/v1/commissionRate?${QUERY}&signature=${sig}`
    const redacted = redactSignature(`falló ${url} (intento 2)`)
    expect(redacted).not.toContain(sig)
    expect(redacted).toContain('signature=[redactada]')
    expect(redacted).toContain('(intento 2)')
    expect(redactSignature(`signature=${sig}&timestamp=1`)).toBe('signature=[redactada]&timestamp=1')
  })

  it('deja igual un texto sin firma', () => {
    expect(redactSignature('HTTP 401 /fapi/v1/leverageBracket')).toBe('HTTP 401 /fapi/v1/leverageBracket')
  })
})

describe('isKeyRejected', () => {
  const http = (status: number, code: number | null) => new BinanceHttpError('x', { status, code, path: '/fapi/v1/leverageBracket' })

  it('clave inválida, formato, firma, permisos o cuenta de futuros (-2015, -2014, -1022, -4xxx)', () => {
    expect(isKeyRejected(http(401, -2015))).toBe(true)
    expect(isKeyRejected(http(401, -2014))).toBe(true)
    expect(isKeyRejected(http(400, -1022))).toBe(true)
    expect(isKeyRejected(http(400, -4001))).toBe(true)
    expect(isKeyRejected(http(400, -4999))).toBe(true)
  })

  it('un 401 sin código también es la clave', () => {
    expect(isKeyRejected(http(401, null))).toBe(true)
  })

  it('el reloj, Binance caído, el límite o la red no son la clave', () => {
    expect(isKeyRejected(http(400, -1021))).toBe(false)
    expect(isKeyRejected(http(500, null))).toBe(false)
    expect(isKeyRejected(http(403, null))).toBe(false)
    expect(isKeyRejected(http(400, -5000))).toBe(false)
    expect(isKeyRejected(new BinanceNetworkError('red', '/fapi/v1/time'))).toBe(false)
    expect(isKeyRejected(new Error('otra cosa'))).toBe(false)
  })
})
