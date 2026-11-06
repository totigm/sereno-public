import { describe, it, expect } from 'vitest'
import { bankruptcyPrice, liquidationCrossed, orderTriggered } from '../../src/exchange/triggers'

describe('orderTriggered (por precio de marca, como Binance)', () => {
  it('STOP_MARKET sell dispara con marca ≤ stop; buy con marca ≥ stop', () => {
    const sell = { type: 'STOP_MARKET', side: 'sell', stopPrice: 95 } as const
    expect(orderTriggered(sell, 95.01)).toBe(false)
    expect(orderTriggered(sell, 95)).toBe(true)
    expect(orderTriggered(sell, 90)).toBe(true)
    const buy = { type: 'STOP_MARKET', side: 'buy', stopPrice: 105 } as const
    expect(orderTriggered(buy, 104.99)).toBe(false)
    expect(orderTriggered(buy, 105)).toBe(true)
  })

  it('TAKE_PROFIT_MARKET al revés: sell con marca ≥ stop; buy con marca ≤ stop', () => {
    const sell = { type: 'TAKE_PROFIT_MARKET', side: 'sell', stopPrice: 105 } as const
    expect(orderTriggered(sell, 104.99)).toBe(false)
    expect(orderTriggered(sell, 105)).toBe(true)
    const buy = { type: 'TAKE_PROFIT_MARKET', side: 'buy', stopPrice: 95 } as const
    expect(orderTriggered(buy, 95.01)).toBe(false)
    expect(orderTriggered(buy, 95)).toBe(true)
  })
})

describe('liquidationCrossed', () => {
  it('long con marca ≤ liquidación, short con marca ≥ liquidación', () => {
    expect(liquidationCrossed('long', 80.9, 80.8)).toBe(false)
    expect(liquidationCrossed('long', 80.8, 80.8)).toBe(true)
    expect(liquidationCrossed('short', 118.8, 118.81)).toBe(false)
    expect(liquidationCrossed('short', 118.81, 118.81)).toBe(true)
  })
})

describe('bankruptcyPrice', () => {
  it('es el precio donde el pnl se come el margen completo', () => {
    // Long 1 a 100 con margen 20 (5x) ⇒ 80; short ⇒ 120.
    expect(bankruptcyPrice('long', 100, 20, 1)).toBe(80)
    expect(bankruptcyPrice('short', 100, 20, 1)).toBe(120)
    expect(bankruptcyPrice('long', 100, 10, 0.5)).toBe(80)
  })
})
