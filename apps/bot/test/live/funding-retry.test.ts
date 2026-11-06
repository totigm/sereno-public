import { describe, expect, it } from 'vitest'
import type { FundingEvent, MarkTick } from '@sereno/core'
import { FundingRetries, MAX_FUNDING_ATTEMPTS } from '../../src/live/funding-retry'
import { openPosition } from '../helpers/engine-fixtures'

const AT = Date.UTC(2026, 9, 31, 16, 0, 0)
const EMPTY_MARK: FundingEvent = { symbol: 'ETHUSDT', at: AT, rate: 0.0001, markPrice: 0 }
const ETH = openPosition({ id: 'eth', symbol: 'ETHUSDT', openedAt: AT - 3_600_000 })

function tick(markPrice: number, symbol = 'ETHUSDT'): MarkTick {
  return { symbol, markPrice, lastPrice: markPrice, at: AT + 60_000, fundingRate: 0.0001, nextFundingTime: AT + 8 * 3_600_000 }
}

describe('FundingRetries', () => {
  it('reintenta con la marca del próximo tick válido de la moneda', () => {
    const retries = new FundingRetries()
    retries.failed(EMPTY_MARK)
    expect(retries.has('ETHUSDT')).toBe(true)
    expect(retries.take(tick(0), [ETH])).toEqual([])
    expect(retries.take(tick(2_500, 'SOLUSDT'), [ETH])).toEqual([])
    expect(retries.take(tick(2_500), [ETH])).toEqual([{ event: { ...EMPTY_MARK, markPrice: 2_500 }, last: false }])
    retries.charged(EMPTY_MARK)
    expect(retries.has('ETHUSDT')).toBe(false)
  })

  it('el reintento es acotado: al llegar al máximo de intentos se abandona', () => {
    const retries = new FundingRetries()
    for (let attempt = 1; attempt < MAX_FUNDING_ATTEMPTS; attempt++) {
      retries.failed(EMPTY_MARK)
      expect(retries.take(tick(2_500), [ETH])).toEqual([{ event: { ...EMPTY_MARK, markPrice: 2_500 }, last: attempt + 1 === MAX_FUNDING_ATTEMPTS }])
    }
    retries.failed(EMPTY_MARK)
    expect(retries.has('ETHUSDT')).toBe(false)
    expect(retries.take(tick(2_500), [ETH])).toEqual([])
  })

  it('sin la posición que lo debía no se cobra a nadie', () => {
    const retries = new FundingRetries()
    retries.failed(EMPTY_MARK)
    // La que lo debía cerró y abrió otra después de la liquidación.
    expect(retries.take(tick(2_500), [openPosition({ id: 'eth2', symbol: 'ETHUSDT', openedAt: AT + 1_000 })])).toEqual([])
    expect(retries.has('ETHUSDT')).toBe(false)
    retries.failed(EMPTY_MARK)
    expect(retries.take(tick(2_500), [])).toEqual([])
    expect(retries.has('ETHUSDT')).toBe(false)
  })
})
