import { describe, expect, it } from 'vitest'
import { symbolExtremes } from '../../src/replay/report'

const stats = (trades: number, pnlNet: number) => ({ trades, wins: 0, pnlNet, winRate: 0 })

describe('symbolExtremes', () => {
  it('la mejor y la peor moneda por resultado neto', () => {
    expect(symbolExtremes({ ETHUSDT: stats(3, 12.5), BTCUSDT: stats(2, -4), SOLUSDT: stats(1, 1) })).toEqual({
      best: { symbol: 'ETHUSDT', trades: 3, pnlNet: 12.5 },
      worst: { symbol: 'BTCUSDT', trades: 2, pnlNet: -4 },
    })
  })

  it('con menos de dos monedas operadas no hay mejor ni peor: no hay con qué comparar', () => {
    expect(symbolExtremes({ ETHUSDT: stats(3, -2) })).toEqual({ best: null, worst: null })
    expect(symbolExtremes({})).toEqual({ best: null, worst: null })
  })
})
