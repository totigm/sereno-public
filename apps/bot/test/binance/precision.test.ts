import { describe, expect, it } from 'vitest'
import { formatPrice, formatQty } from '../../src/binance/precision'

describe('formatQty / formatPrice', () => {
  it('redondea hacia abajo a la grilla del contrato', () => {
    expect(formatQty(0.12345, 0.001)).toBe('0.123')
    expect(formatPrice(64123.456, 0.1)).toBe('64123.4')
    expect(formatQty(3.9, 1)).toBe('3')
    expect(formatPrice(0.0123456, 0.0000001)).toBe('0.0123456')
  })

  it('nunca escribe notación exponencial', () => {
    expect(formatQty(1e-7, 1e-8)).toBe('0.00000010')
    expect(formatQty(123456789, 1)).toBe('123456789')
    expect(formatPrice(5e-7, 1e-7)).toBe('0.0000005')
  })

  it('no pierde un paso por el ruido de la coma flotante', () => {
    // 0.3 / 0.1 = 2.9999999999999996 en coma flotante.
    expect(formatQty(0.3, 0.1)).toBe('0.3')
    expect(formatQty(0.07, 0.01)).toBe('0.07')
    expect(formatPrice(1.1, 0.1)).toBe('1.1')
  })

  it('respeta grillas que no son potencias de diez', () => {
    expect(formatPrice(10.37, 0.25)).toBe('10.25')
    expect(formatPrice(99.99, 0.5)).toBe('99.5')
  })

  it('debajo de un paso queda en cero', () => {
    expect(formatQty(0.0004, 0.001)).toBe('0.000')
  })

  it('rechaza cantidades o grillas inválidas en vez de mandar basura', () => {
    expect(() => formatQty(-1, 0.001)).toThrow(RangeError)
    expect(() => formatQty(Number.NaN, 0.001)).toThrow(RangeError)
    expect(() => formatQty(1, 0)).toThrow(RangeError)
    expect(() => formatPrice(1, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})
