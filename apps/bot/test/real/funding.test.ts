import type { FundingApplied } from '@sereno/core/src/exchange/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { FundingCollector } from '../../src/real/funding'
import { realRig, REAL_T0, type RealRig } from '../helpers/real'

const WAIT = { timeout: 3_000, interval: 5 }
const SOL = 'SOLUSDT'

describe('FundingCollector', () => {
  let fake: FakeBinance
  let r: RealRig
  let collector: FundingCollector
  let heard: FundingApplied[][]

  const incomeRequests = () => fake.requests.filter((q) => q.path === '/fapi/v1/income').length

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  beforeEach(async () => {
    fake.reset()
    fake.trading.setMark(SOL, 150)
    r = await realRig(fake)
    r.exchange.setPrices(SOL, { mark: 150, last: 150 })
    collector = new FundingCollector({ trade: r.kit.trade, exchange: r.exchange, account: r.account, since: REAL_T0 })
    collector.start()
    heard = []
    collector.onFunding((applied) => heard.push(applied))
  })
  afterEach(async () => {
    collector.stop()
    r.exchange.detach()
    await r.account.stop()
  })

  async function openSol(qty: number): Promise<void> {
    await r.exchange.setLeverage(SOL, 3)
    await r.exchange.placeMarketOrder({ symbol: SOL, side: 'buy', qty })
  }

  it('cobra el funding que informa Binance, una sola vez por tranId', async () => {
    await openSol(2)
    await r.clock.advance(1_000)
    fake.trading.chargeFunding(SOL, 0.0001)
    const row = fake.trading.income.at(-1)!

    // El ACCOUNT_UPDATE con FUNDING_FEE lo dispara solo.
    await vi.waitFor(() => expect(heard).toHaveLength(1), WAIT)
    const expected = { symbol: SOL, side: 'long', qty: 2, markPrice: 150, at: row.time }
    expect(heard[0]).toMatchObject([expected])
    expect(heard[0]![0]!.amount).toBeCloseTo(-0.03, 12)
    expect(heard[0]![0]!.rate).toBeCloseTo(0.0001, 12)

    // La reconciliación vuelve a pedir: la misma fila no se cuenta otra vez.
    const before = incomeRequests()
    expect(await collector.collect()).toEqual([])
    expect(incomeRequests()).toBe(before + 1)
    expect(heard).toHaveLength(1)

    // Llega al motor con applyFunding, una vez.
    const total = (await r.exchange.getBalance()).total
    const ev = { symbol: SOL, at: row.time, rate: 0.0001, markPrice: 150 }
    expect(r.exchange.applyFunding(ev)).toHaveLength(1)
    expect(r.exchange.applyFunding(ev)).toEqual([])
    expect((await r.exchange.getBalance()).total - total).toBeCloseTo(-0.03, 12)
  })

  it('con cantidad de Toti en la moneda reparte por la del bot', async () => {
    await openSol(1)
    fake.trading.manualPosition(SOL, 3)
    await vi.waitFor(() => expect(r.account.position(SOL)!.amount).toBe(4), WAIT)
    await r.clock.advance(1_000)
    fake.trading.chargeFunding(SOL, 0.0002)
    const row = fake.trading.income.at(-1)!
    // Binance cobra sobre los 4: −4·150·0,0002 = −0,12. Al bot le toca un cuarto.
    expect(Number(row.income)).toBeCloseTo(-0.12, 12)

    await vi.waitFor(() => expect(heard).toHaveLength(1), WAIT)
    expect(heard[0]![0]).toMatchObject({ symbol: SOL, qty: 1 })
    expect(heard[0]![0]!.amount).toBeCloseTo(-0.03, 12)
    expect(heard[0]![0]!.rate).toBeCloseTo(0.0002, 12)
  })

  it('antes de start no lee nada: lo cobrado espera a que el adaptador tenga las posiciones', async () => {
    collector.stop()
    const idle = new FundingCollector({ trade: r.kit.trade, exchange: r.exchange, account: r.account, since: REAL_T0 })
    idle.onFunding((applied) => heard.push(applied))
    await openSol(2)
    await r.clock.advance(1_000)
    const before = incomeRequests()
    const reasons: string[] = []
    const off = r.account.onAccountUpdate((u) => reasons.push(u.reason))
    fake.trading.chargeFunding(SOL, 0.0001)
    await vi.waitFor(() => expect(reasons).toContain('FUNDING_FEE'), WAIT)
    off()
    expect(incomeRequests()).toBe(before)
    idle.start()
    expect(await idle.collect()).toHaveLength(1)
    idle.stop()
  })

  it('no cuenta el funding de una moneda donde el bot no tiene posición', async () => {
    fake.trading.manualPosition(SOL, 3)
    await r.clock.advance(1_000)
    fake.trading.chargeFunding(SOL, 0.0001)
    expect(await collector.collect()).toEqual([])
    expect(heard).toEqual([])
    expect(r.exchange.applyFunding({ symbol: SOL, at: REAL_T0, rate: 0.0001, markPrice: 150 })).toEqual([])
  })
})
