import { describe, expect, it } from 'vitest'
import { coinName, withCoinNames } from '../../src/journal/coin-name'

describe('coinName', () => {
  it('recorta la moneda de cotización y deja el resto igual', () => {
    expect(coinName('SOLUSDT')).toBe('SOL')
    expect(coinName('BTCUSDC')).toBe('BTC')
    expect(coinName('USDT')).toBe('USDT')
    expect(coinName('SOL')).toBe('SOL')
  })

  it('recorta el prefijo multiplicador de Binance cuando lo siguen letras', () => {
    expect(coinName('1000PEPEUSDT')).toBe('PEPE')
    expect(coinName('1000000MOGUSDT')).toBe('MOG')
    expect(coinName('10000LADYSUSDT')).toBe('LADYS')
    expect(coinName('1MBABYDOGEUSDT')).toBe('BABYDOGE')
    expect(coinName('1000SHIBUSDC')).toBe('SHIB')
  })

  it('no confunde un nombre que empieza con dígitos con el prefijo', () => {
    expect(coinName('1INCHUSDT')).toBe('1INCH')
    expect(coinName('1000USDT')).toBe('1000')
    expect(coinName('1000')).toBe('1000')
  })

  it('en texto libre cambia sólo los símbolos de contrato', () => {
    expect(withCoinNames('Confianza en SOLUSDT tras el VWAP; BTCUSDT igual (n = 14).')).toBe(
      'Confianza en SOL tras el VWAP; BTC igual (n = 14).',
    )
    expect(withCoinNames('Penitencia en 1000PEPEUSDT; 1000000 trades no alcanzan.')).toBe(
      'Penitencia en PEPE; 1000000 trades no alcanzan.',
    )
  })
})
