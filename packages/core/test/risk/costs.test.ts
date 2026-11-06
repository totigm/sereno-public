import { describe, it, expect } from 'vitest'
import { roundTripCost } from '../../src/risk/costs'
import { btcLikeInfo, exampleSettings } from './fixtures'

describe('roundTripCost', () => {
  it('suma dos comisiones taker, el spread completo y dos slippages', () => {
    // 2×0.0005 + 2×0.0001 + 2×0.0002 = 0.0016 (ejemplo de spec §5.5)
    expect(roundTripCost(btcLikeInfo(), exampleSettings().risk)).toBeCloseTo(0.0016, 10)
  })
  it('es cero cuando no hay costos', () => {
    const risk = exampleSettings({ risk: { takerFeeRate: 0, slippageRate: 0 } }).risk
    expect(roundTripCost(btcLikeInfo({ halfSpreadRate: 0 }), risk)).toBe(0)
  })
})
