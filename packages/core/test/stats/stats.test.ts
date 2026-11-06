import { describe, expect, it } from 'vitest'
import { computeStats, maxDrawdown } from '../../src/stats/stats'
import { closedFromR, makeClosed } from './fixtures'

const equityAt = (values: number[]) => values.map((equity, i) => ({ at: i * 60_000, equity }))

describe('computeStats', () => {
  it('3 trades (+2R, −1R, +1R): winRate 2/3, expectancyR 0,667, profitFactor 3', () => {
    const stats = computeStats(closedFromR([2, -1, 1]), [])
    expect(stats.trades).toBe(3)
    expect(stats.wins).toBe(2)
    expect(stats.losses).toBe(1)
    expect(stats.winRate).toBeCloseTo(2 / 3, 10)
    expect(stats.expectancyR).toBeCloseTo(0.667, 3)
    expect(stats.profitFactor).toBe(3)
  })

  it('ganancia y pérdida medias, mejor y peor trade en pnlNet', () => {
    const stats = computeStats(closedFromR([2, -1, 1]), [])
    expect(stats.avgWin).toBe(15)
    expect(stats.avgLoss).toBe(-10)
    expect(stats.bestTrade).toBe(20)
    expect(stats.worstTrade).toBe(-10)
  })

  it('suma los costos desglosados y calcula costo medio / riesgo medio en R', () => {
    const closed = [
      makeClosed({ id: 'a', rMultiple: 1, costs: { fees: 1, spread: 0.5, slippage: 0.25, funding: 0.1 } }),
      makeClosed({ id: 'b', rMultiple: -1, costs: { fees: 1, spread: 0.5, slippage: 0.25, funding: -0.1 } }),
    ]
    const stats = computeStats(closed, [])
    expect(stats.costs).toEqual({ fees: 2, spread: 1, slippage: 0.5, funding: 0 })
    // costo total 3,5 sobre riesgo total 20 ⇒ 0,175R por trade
    expect(stats.costPerRiskR).toBeCloseTo(0.175, 10)
  })

  it('cuenta liquidaciones y agrupa por moneda', () => {
    const closed = [
      makeClosed({ id: 'a', symbol: 'SOLUSDT', rMultiple: 2 }),
      makeClosed({ id: 'b', symbol: 'SOLUSDT', rMultiple: -1 }),
      makeClosed({ id: 'c', symbol: 'ETHUSDT', rMultiple: -1, closeReason: 'liquidation' }),
    ]
    const stats = computeStats(closed, [])
    expect(stats.liquidations).toBe(1)
    expect(stats.bySymbol).toEqual({
      SOLUSDT: { trades: 2, wins: 1, pnlNet: 10, winRate: 0.5 },
      ETHUSDT: { trades: 1, wins: 0, pnlNet: -10, winRate: 0 },
    })
  })

  it('toma el drawdown máximo de la serie de equity', () => {
    const stats = computeStats(closedFromR([1]), equityAt([100, 120, 90, 130]))
    expect(stats.maxDrawdownPct).toBeCloseTo(0.25, 10)
  })

  it('sin trades devuelve ceros en vez de NaN', () => {
    const stats = computeStats([], [])
    expect(stats).toEqual({
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      profitFactor: 0,
      expectancyR: 0,
      avgWin: 0,
      avgLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      maxDrawdownPct: 0,
      costs: { fees: 0, spread: 0, slippage: 0, funding: 0 },
      costPerRiskR: 0,
      liquidations: 0,
      bySymbol: {},
    })
  })

  it('sin pérdidas el factor de beneficio es infinito; un trade en cero no es ganado ni perdido', () => {
    const stats = computeStats(closedFromR([1, 0]), [])
    expect(stats.trades).toBe(2)
    expect(stats.wins).toBe(1)
    expect(stats.losses).toBe(0)
    expect(stats.profitFactor).toBe(Number.POSITIVE_INFINITY)
    expect(stats.avgLoss).toBe(0)
  })

  it('mezclar posiciones reales y de la sombra es un error; sólo sombra se acepta', () => {
    const real = makeClosed({ id: 'real', rMultiple: 1 })
    const sombra = makeClosed({ id: 'sombra', rMultiple: -1, shadow: true })
    expect(() => computeStats([real, sombra], [])).toThrow(RangeError)
    expect(computeStats([sombra], []).trades).toBe(1)
  })
})

describe('maxDrawdown', () => {
  it('[100, 120, 90, 130] ⇒ 25% con pico en 120 y valle en 90', () => {
    const dd = maxDrawdown(equityAt([100, 120, 90, 130]))
    expect(dd.pct).toBeCloseTo(0.25, 10)
    expect(dd.peakAt).toBe(60_000)
    expect(dd.troughAt).toBe(120_000)
  })

  it('serie creciente ⇒ 0 sin pico ni valle', () => {
    expect(maxDrawdown(equityAt([100, 110, 120]))).toEqual({ pct: 0, peakAt: null, troughAt: null })
  })

  it('serie vacía ⇒ 0', () => {
    expect(maxDrawdown([])).toEqual({ pct: 0, peakAt: null, troughAt: null })
  })

  it('se queda con la peor caída aunque después haya otra menor', () => {
    const dd = maxDrawdown(equityAt([100, 50, 200, 180]))
    expect(dd.pct).toBeCloseTo(0.5, 10)
    expect(dd.peakAt).toBe(0)
    expect(dd.troughAt).toBe(60_000)
  })
})
