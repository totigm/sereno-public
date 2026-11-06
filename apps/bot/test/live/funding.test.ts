import { describe, expect, it } from 'vitest'
import type { MarkTick } from '@sereno/core'
import { FundingTracker } from '../../src/live/funding'

const T = Date.UTC(2026, 9, 31, 8, 0, 0)

function tick(at: number, markPrice: number, fundingRate: number | null, nextFundingTime: number | null): MarkTick {
  return { symbol: 'SOLUSDT', markPrice, lastPrice: markPrice, at, fundingRate, nextFundingTime }
}

describe('FundingTracker', () => {
  it('aplica el funding cuando el próximo instante avanza, con la última tasa del período', () => {
    const funding = new FundingTracker()
    expect(funding.note(tick(T - 2_000, 150, 0.0001, T))).toBeNull()
    expect(funding.note(tick(T - 1_000, 151, 0.00012, T))).toBeNull()
    expect(funding.note(tick(T + 1_000, 152, 0.00005, T + 8 * 3_600_000))).toEqual({ symbol: 'SOLUSDT', at: T, rate: 0.00012, markPrice: 152 })
    expect(funding.note(tick(T + 2_000, 152, 0.00005, T + 8 * 3_600_000))).toBeNull()
  })

  it('sin tasa o sin instante conocidos no inventa un funding', () => {
    const funding = new FundingTracker()
    expect(funding.note(tick(T - 1_000, 150, null, T))).toBeNull()
    expect(funding.note(tick(T + 1_000, 150, 0.0001, T + 8 * 3_600_000))).toBeNull()
  })
})
