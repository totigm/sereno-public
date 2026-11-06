import { describe, expect, it } from 'vitest'
import type { UserTrade } from '../../src/binance/trade-types'
import { CancelBackoff } from '../../src/real/cancel-backoff'
import { completeFill, type TradesApi } from '../../src/real/fill-completion'
import type { OrderFill } from '../../src/real/order-tracker'

const fill: OrderFill = { clientOrderId: 'sereno-0a1b2c3d-o1', orderId: 7, qty: 4, avgPrice: 100, commission: 0.1, realizedPnl: 0, at: 1_000, status: 'FILLED', complete: false }
const trade = (qty: number, commission: number, realizedPnl = 0): UserTrade => ({ id: qty, orderId: 7, symbol: 'SOLUSDT', side: 'BUY', price: 100, qty, commission, commissionAsset: 'USDT', realizedPnl, time: 1_100 })

function tradesOf(rows: UserTrade[]): TradesApi & { asked: unknown[] } {
  const asked: unknown[] = []
  return {
    asked,
    userTrades: async (_symbol, query) => {
      asked.push(query)
      return rows
    },
  }
}

const estimate = { takerFeeRate: 0.0005, realizedPnl: () => 2 }

describe('completeFill', () => {
  it('un fill completo no pregunta nada', async () => {
    const api = tradesOf([])
    expect(await completeFill(api, 'SOLUSDT', { ...fill, complete: true }, estimate)).toEqual({ fill: { ...fill, complete: true }, estimated: false })
    expect(api.asked).toEqual([])
  })

  it('vuelve a pedir los trades por orderId y usa los que ya están', async () => {
    const api = tradesOf([trade(1, 0.05), trade(3, 0.15)])
    const done = await completeFill(api, 'SOLUSDT', fill, estimate)
    expect(api.asked).toEqual([{ orderId: 7 }])
    expect(done).toEqual({ fill: { ...fill, commission: 0.2, at: 1_100, complete: true }, estimated: false })
  })

  it('si siguen faltando, estima en proporción a lo visto', async () => {
    const done = await completeFill(tradesOf([trade(1, 0.05, 0.5)]), 'SOLUSDT', fill, estimate)
    expect(done.estimated).toBe(true)
    expect(done.fill.commission).toBeCloseTo(0.2, 12)
    expect(done.fill.realizedPnl).toBeCloseTo(2, 12)
  })

  it('sin ningún trade visto, la comisión taker y el pnl que da quien llama', async () => {
    const done = await completeFill(tradesOf([]), 'SOLUSDT', fill, estimate)
    expect(done).toEqual({ fill: { ...fill, commission: 4 * 100 * 0.0005, realizedPnl: 2 }, estimated: true })
  })
})

describe('CancelBackoff', () => {
  it('espera 1 s, 2 s, 4 s… hasta 60 s entre intentos', () => {
    let now = 0
    const b = new CancelBackoff(() => now)
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      b.failed('s1', 'SOLUSDT')
      waits.push(b.waitFor('s1'))
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    expect(b.due()).toEqual([])
    now = 60_000
    expect(b.due()).toEqual([{ clientAlgoId: 's1', symbol: 'SOLUSDT' }])
    b.done('s1')
    expect(b.all()).toEqual([])
    expect(b.waitFor('s1')).toBe(0)
  })

  it('lo agregado sin fallar está para ya y no pisa una espera en curso', () => {
    const b = new CancelBackoff(() => 0)
    b.add('t1', 'SOLUSDT')
    b.failed('s1', 'SOLUSDT')
    b.add('s1', 'SOLUSDT')
    expect(b.due()).toEqual([{ clientAlgoId: 't1', symbol: 'SOLUSDT' }])
    expect(b.waitFor('s1')).toBe(1_000)
  })
})
