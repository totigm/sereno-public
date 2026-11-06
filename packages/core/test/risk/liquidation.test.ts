import { describe, it, expect } from 'vitest'
import { liquidationPrice, liquidationFarEnough } from '../../src/risk/liquidation'

describe('liquidationPrice (aislado, tier 1, cum = 0)', () => {
  it('long 5x con mmr 1% ⇒ 100 × 0,8 / 0,99', () => {
    expect(liquidationPrice('long', 100, 5, 0.01)).toBeCloseTo(80.808, 3)
  })
  it('short 5x con mmr 1% ⇒ 100 × 1,2 / 1,01', () => {
    expect(liquidationPrice('short', 100, 5, 0.01)).toBeCloseTo(118.812, 3)
  })
  it('a mayor apalancamiento la liquidación se acerca a la entrada', () => {
    expect(liquidationPrice('long', 100, 10, 0.01)).toBeGreaterThan(liquidationPrice('long', 100, 5, 0.01))
    expect(liquidationPrice('short', 100, 10, 0.01)).toBeLessThan(liquidationPrice('short', 100, 5, 0.01))
  })
})

describe('liquidationFarEnough (|liq − entrada| ≥ 3 × |stop − entrada|)', () => {
  it('acepta cuando la liquidación queda a 3 stops o más', () => {
    expect(liquidationFarEnough({ side: 'long', entry: 100, stopPrice: 98.72, liquidationPrice: 80.808 })).toBe(true)
    expect(liquidationFarEnough({ side: 'short', entry: 100, stopPrice: 101.28, liquidationPrice: 118.812 })).toBe(true)
  })
  it('rechaza cuando queda a menos de 3 stops', () => {
    expect(liquidationFarEnough({ side: 'long', entry: 100, stopPrice: 90, liquidationPrice: 80.808 })).toBe(false)
    expect(liquidationFarEnough({ side: 'short', entry: 100, stopPrice: 110, liquidationPrice: 118.812 })).toBe(false)
  })
  it('acepta exactamente 3 stops y respeta un múltiplo distinto', () => {
    expect(liquidationFarEnough({ side: 'long', entry: 100, stopPrice: 95, liquidationPrice: 85 })).toBe(true)
    expect(liquidationFarEnough({ side: 'long', entry: 100, stopPrice: 95, liquidationPrice: 85 }, 4)).toBe(false)
  })
  it('rechaza una liquidación del lado equivocado de la entrada', () => {
    expect(liquidationFarEnough({ side: 'long', entry: 100, stopPrice: 99, liquidationPrice: 120 })).toBe(false)
    expect(liquidationFarEnough({ side: 'short', entry: 100, stopPrice: 101, liquidationPrice: 80 })).toBe(false)
  })
})
