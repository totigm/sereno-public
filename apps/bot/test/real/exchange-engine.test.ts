import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { markTick, realEngine, realRig, realView, REAL_T0, type RealRig } from '../helpers/real'

const WAIT = { timeout: 3_000, interval: 5 }
const ETH = 'ETHUSDT'

describe('el motor sobre el exchange real', () => {
  let fake: FakeBinance
  let r: RealRig

  beforeAll(async () => {
    fake = await FakeBinance.start()
  })
  afterAll(async () => {
    await fake.stop()
  })
  afterEach(async () => {
    r.exchange.detach()
    await r.account.stop()
  })

  it('sin sombra abre, protege y cierra por el take profit de Binance', async () => {
    fake.reset()
    fake.trading.setMark(ETH, 2_000)
    r = await realRig(fake)
    r.exchange.setPrices(ETH, { mark: 2_000, last: 2_000 })
    const { engine, events } = realEngine(r, { [ETH]: 0.9 })

    await r.clock.advance(2_000)
    const cycle = await engine.onCandleClose([realView(ETH, REAL_T0, 2_000, 20)], { missingSymbols: [], degraded: [] })
    expect(cycle.opened.map((p) => [p.symbol, p.side])).toEqual([[ETH, 'long']])
    const opened = cycle.opened[0]!
    expect(fake.trading.marginType(ETH)).toBe('isolated')
    expect(fake.trading.leverage(ETH)).toBe(opened.leverage)
    const algos = fake.trading.algos.map((a) => [a.orderType, a.quantity, a.reduceOnly, a.workingType, a.algoStatus])
    const qty = fake.trading.position(ETH)!.amount.toFixed(3)
    expect(algos).toEqual([
      ['STOP_MARKET', qty, true, 'MARK_PRICE', 'NEW'],
      ['TAKE_PROFIT_MARKET', qty, true, 'MARK_PRICE', 'NEW'],
    ])
    const tp = Number(fake.trading.algos[1]!.triggerPrice)

    const above = tp + 1
    fake.trading.setMark(ETH, above)
    await vi.waitFor(() => expect(r.exchange.hasPendingClose(ETH)).toBe(true), WAIT)
    await engine.onMarkTick(markTick(ETH, above, r.clock.now()))

    const closed = events.flatMap((e) => (e.type === 'position_closed' ? [e] : []))
    expect(closed.map((e) => [e.position.symbol, e.position.closeReason, e.fill.reported])).toEqual([[ETH, 'take_profit', true]])
    const trades = fake.trading.trades
    const realized = trades.reduce((s, t) => s + Number(t.realizedPnl) - Number(t.commission), 0)
    expect(closed[0]!.position.pnlNet).toBeCloseTo(realized, 8)
    expect(fake.trading.position(ETH)).toBeNull()
    await vi.waitFor(() => expect(fake.trading.algos.map((a) => a.algoStatus)).toEqual(['CANCELED', 'FINISHED']), WAIT)
  })
})
