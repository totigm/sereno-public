import { describe, expect, it } from 'vitest'
import { toCommissionRate, toTierOneMmr } from '../../src/binance/account'
import type { RawLeverageBracket } from '../../src/binance/types'

const bracket = (floor: number, mmr: number, n: number) => ({
  bracket: n,
  initialLeverage: 125 - n * 25,
  notionalCap: floor + 50_000,
  notionalFloor: floor,
  maintMarginRatio: mmr,
  cum: floor * 0.001,
})

describe('toTierOneMmr', () => {
  it('toma por símbolo el mmr del bracket con notionalFloor 0, aunque no venga primero', () => {
    const raw: RawLeverageBracket[] = [
      { symbol: 'BTCUSDT', brackets: [bracket(50_000, 0.005, 2), bracket(0, 0.004, 1)] },
      { symbol: 'ETHUSDT', notionalCoef: 1.5, brackets: [bracket(0, 0.005, 1)] },
    ]
    expect(toTierOneMmr(raw)).toEqual(new Map([['BTCUSDT', 0.004], ['ETHUSDT', 0.005]]))
  })

  it('omite el símbolo sin tier 1 o con un mmr fuera de (0, 1)', () => {
    const raw: RawLeverageBracket[] = [
      { symbol: 'AUSDT', brackets: [bracket(10_000, 0.01, 2)] },
      { symbol: 'BUSDT', brackets: [] },
      { symbol: 'CUSDT', brackets: [bracket(0, 0, 1)] },
      { symbol: 'DUSDT', brackets: [bracket(0, 1, 1)] },
      { symbol: 'EUSDT', brackets: [{ ...bracket(0, 0.02, 1), maintMarginRatio: Number.NaN }] },
      { symbol: 'FUSDT', brackets: [bracket(0, 0.025, 1)] },
    ]
    expect(toTierOneMmr(raw)).toEqual(new Map([['FUSDT', 0.025]]))
  })
})

describe('toCommissionRate', () => {
  it('convierte las comisiones de string a número', () => {
    expect(toCommissionRate({ symbol: 'BTCUSDT', makerCommissionRate: '0.000180', takerCommissionRate: '0.000450' })).toEqual({
      symbol: 'BTCUSDT',
      makerFeeRate: 0.00018,
      takerFeeRate: 0.00045,
    })
  })

  it('rechaza una comisión negativa o ilegible', () => {
    expect(() => toCommissionRate({ symbol: 'BTCUSDT', makerCommissionRate: '-0.0001', takerCommissionRate: '0.0004' })).toThrow(/comisión/)
    expect(() => toCommissionRate({ symbol: 'BTCUSDT', makerCommissionRate: '0.0002', takerCommissionRate: 'abc' })).toThrow(/comisión/)
  })
})
