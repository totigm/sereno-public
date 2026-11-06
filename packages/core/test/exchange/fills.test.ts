import { describe, it, expect } from 'vitest'
import { fillPrice, slippageForNotional } from '../../src/exchange/fills'

const base = { halfSpreadRate: 0.0001, slippageRate: 0.0002 }

describe('slippageForNotional', () => {
  it('es la base por debajo de 10.000 de nocional', () => {
    expect(slippageForNotional(0.0002, 100)).toBe(0.0002)
    expect(slippageForNotional(0.0002, 9_999.99)).toBe(0.0002)
  })
  it('suma 0,01% por cada 10.000 completos', () => {
    expect(slippageForNotional(0.0002, 10_000)).toBeCloseTo(0.0003, 12)
    expect(slippageForNotional(0.0002, 25_000)).toBeCloseTo(0.0004, 12)
  })
})

describe('fillPrice', () => {
  it('compra 1 BTC a 100 ⇒ 100,03 con medio spread 0,01% y slippage 0,02%', () => {
    const fill = fillPrice({ ...base, lastPrice: 100, notional: 100, side: 'buy' })
    expect(fill.price).toBeCloseTo(100.03, 10)
    expect(fill.spreadCost).toBeCloseTo(0.01, 10)
    expect(fill.slippageCost).toBeCloseTo(0.02, 10)
  })
  it('venta ⇒ el mismo costo pero hacia abajo', () => {
    const fill = fillPrice({ ...base, lastPrice: 100, notional: 100, side: 'sell' })
    expect(fill.price).toBeCloseTo(99.97, 10)
  })
  it('un nocional grande paga más slippage', () => {
    const fill = fillPrice({ ...base, lastPrice: 100, notional: 25_000, side: 'buy' })
    expect(fill.price).toBeCloseTo(100 * (1 + 0.0001 + 0.0004), 10)
    expect(fill.slippageCost).toBeCloseTo(25_000 * 0.0004, 8)
  })
  it('adverseExtra se suma al slippage (stop: medio spread + 2 × slippage en total)', () => {
    const fill = fillPrice({ ...base, lastPrice: 94.9, notional: 94.9, side: 'sell', adverseExtra: 0.0002 })
    expect(fill.price).toBeCloseTo(94.9 * (1 - (0.0001 + 2 * 0.0002)), 10)
    expect(fill.spreadCost).toBeCloseTo(94.9 * 0.0001, 10)
    expect(fill.slippageCost).toBeCloseTo(94.9 * 0.0004, 10)
  })
  it('sin costos el fill es el último precio', () => {
    const fill = fillPrice({ lastPrice: 50, halfSpreadRate: 0, slippageRate: 0, notional: 50, side: 'buy' })
    expect(fill).toEqual({ price: 50, spreadCost: 0, slippageCost: 0 })
  })
})
