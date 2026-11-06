import { describe, expect, it } from 'vitest'
import type { Position } from '../../src/types'
import { harness, HOUR, infoOf, LATENCY, MIN, MIN15, NO_CONTEXT, ofType, positionOf, settingsWith, stateWith, T, tableScorer, tick, viewOf } from './fixtures'

// Long del brief para el trailing: entrada 100, d 1% (1R = 1 de precio), stop 99.
const briefLong = (overrides: Partial<Position> = {}) => positionOf('SOLUSDT', { id: 'real-SOLUSDT-restored', ...overrides })

async function openSol(score = 0.6) {
  const table: Record<string, number> = { SOLUSDT: score }
  const h = harness({ scorer: tableScorer(table) })
  await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
  return { h, table }
}

describe('TradingEngine — salida por señal y por tiempo', () => {
  it('long con θ de apertura 0,35 y S′ = −0,2 ⇒ cierra signal_flip a mercado', async () => {
    const { h, table } = await openSol()
    table['SOLUSDT'] = -0.2
    h.clock.now = T + MIN15 + LATENCY
    const { closed, decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15, price: 99 })], NO_CONTEXT)
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ symbol: 'SOLUSDT', closeReason: 'signal_flip', exitPrice: 99, closedAt: T + MIN15 + LATENCY })
    expect(closed[0]?.pnlGross).toBeCloseTo(-2.8, 12)
    expect(decisions[0]?.action).toEqual({ kind: 'wait' })
    const [event] = ofType(h.events, 'position_closed')
    expect(event?.phrase).toBe('Cerré el long en SOL porque las señales se dieron vuelta: −US$ 2,80 (−0,3R).')
    expect(await h.exchange.getPositions()).toEqual([])
    expect(await h.exchange.getOpenOrders()).toEqual([])
  })

  it('a las 49 h con +0,1R ⇒ cierra time_exit; con +0,5R sigue abierta', async () => {
    const at49h = T + 49 * HOUR
    const flat = await openSol()
    flat.table['SOLUSDT'] = 0.2
    flat.h.clock.now = at49h + LATENCY
    // 1R = 3 de precio (d 3%) sobre 2,8 de cantidad: +0,1R es la marca en 100,3.
    const exited = await flat.h.engine.onCandleClose([viewOf('SOLUSDT', { t: at49h, price: 100.3 })], NO_CONTEXT)
    expect(exited.closed.map((c) => c.closeReason)).toEqual(['time_exit'])
    expect(ofType(flat.h.events, 'position_closed')[0]?.phrase).toBe('Cerré el long en SOL a las 49 horas sin despegar: +US$ 0,84 (+0,1R).')

    const winning = await openSol()
    winning.table['SOLUSDT'] = 0.2
    winning.h.clock.now = at49h + LATENCY
    const kept = await winning.h.engine.onCandleClose([viewOf('SOLUSDT', { t: at49h, price: 101.5 })], NO_CONTEXT)
    expect(kept.closed).toEqual([])
    expect(winning.h.engine.snapshot().real.positions).toHaveLength(1)
  })
})

describe('TradingEngine — ticks de marca', () => {
  it('trailing: con marca 101 el stop va a 100 (entrada) y con 103 a 102, reemplazando la orden', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(briefLong()))
    await h.engine.onMarkTick(tick('SOLUSDT', 100.5, T + MIN))
    await h.engine.onMarkTick(tick('SOLUSDT', 101, T + 2 * MIN))
    await h.engine.onMarkTick(tick('SOLUSDT', 103, T + 3 * MIN))
    expect(ofType(h.events, 'stop_moved')).toEqual([
      { type: 'stop_moved', positionId: 'real-SOLUSDT-restored', from: 99, to: 100, at: T + 2 * MIN, phrase: 'Moví el stop del long en SOL a la entrada (100,00).' },
      { type: 'stop_moved', positionId: 'real-SOLUSDT-restored', from: 100, to: 102, at: T + 3 * MIN, phrase: 'Subí el stop del long en SOL de 100,00 a 102,00.' },
    ])
    // Una sola orden closePosition por símbolo, tipo y lado (regla −4130 de Binance).
    const orders = await h.exchange.getOpenOrders('SOLUSDT')
    expect(orders.map((o) => [o.type, o.stopPrice])).toEqual([
      ['TAKE_PROFIT_MARKET', 105],
      ['STOP_MARKET', 102],
    ])
    const [position] = h.engine.snapshot().real.positions.map((s) => s.position)
    expect(position).toMatchObject({ stopPrice: 102, bestPrice: 103, trailingActive: true, stopOrderId: orders[1]?.id, tpOrderId: orders[0]?.id })
  })

  it('el stop movido por el trailing que se toca cierra como trailing_stop', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(briefLong()))
    for (const [i, mark] of [100.5, 101, 103, 101.9].entries()) await h.engine.onMarkTick(tick('SOLUSDT', mark, T + (i + 1) * MIN))
    const [closed] = ofType(h.events, 'position_closed')
    expect(closed?.position).toMatchObject({ closeReason: 'trailing_stop', exitPrice: 101.9, stopPrice: 102 })
    expect(closed?.position.rMultiple).toBeCloseTo(1.9, 12)
    expect(closed?.phrase).toBe('Cerré el long en SOL en el trailing stop: +US$ 3,80 (+1,9R).')
  })

  it('un tick que cruza el stop cierra por la orden del exchange, con pnl y R netos', async () => {
    const { h } = await openSol()
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 5 * MIN))
    const [event] = ofType(h.events, 'position_closed')
    expect(event?.position).toMatchObject({ closeReason: 'stop', exitPrice: 96.9, closedAt: T + 5 * MIN })
    expect(event?.position.pnlGross).toBeCloseTo(-8.68, 9)
    expect(event?.position.pnlNet).toBeCloseTo(-8.68, 9)
    expect(event?.position.rMultiple).toBeCloseTo(-8.68 / 8.4, 9)
    expect(h.engine.snapshot().real.positions).toEqual([])
  })

  it('respaldo: si la marca cruzó el stop y el exchange no tenía la orden, cierra igual a mercado', async () => {
    const h = harness({ scorer: tableScorer({}) })
    // Restaurada sin precios: el stop no se pudo colocar todavía.
    await h.engine.restore(stateWith(briefLong()))
    expect(await h.exchange.getOpenOrders()).toEqual([])
    await h.engine.onMarkTick(tick('SOLUSDT', 98.5, T + MIN))
    const [event] = ofType(h.events, 'position_closed')
    expect(event?.position).toMatchObject({ closeReason: 'stop', exitPrice: 98.5 })
    expect(event?.position.pnlGross).toBeCloseTo(-3, 12)
  })

  it('una marca más allá de la liquidación liquida al precio de quiebra: pierde el margen', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(briefLong()))
    await h.engine.onMarkTick(tick('SOLUSDT', 80, T + MIN))
    const [event] = ofType(h.events, 'position_closed')
    // Long en 100 a 5x con 2 de cantidad: quiebra en 80, pnl bruto = −margen.
    expect(event?.position).toMatchObject({ closeReason: 'liquidation', exitPrice: 80, pnlGross: -40, pnlNet: -40, rMultiple: -20 })
    expect(h.engine.snapshot().accounts.real.saldo).toBeCloseTo((await h.exchange.getBalance()).total, 9)
  })

  it('una posición restaurada recupera su stop y su take profit con el primer tick', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(briefLong()))
    await h.engine.onMarkTick(tick('SOLUSDT', 100.2, T + MIN))
    const orders = await h.exchange.getOpenOrders()
    expect(orders.map((o) => [o.type, o.side, o.stopPrice])).toEqual([
      ['STOP_MARKET', 'sell', 99],
      ['TAKE_PROFIT_MARKET', 'sell', 105],
    ])
  })

  it('funding: el long paga qty × marca × tasa; queda en la posición, la cuenta y el pnl neto', async () => {
    const { h } = await openSol()
    await expect(h.engine.onFunding({ symbol: 'SOLUSDT', at: T + HOUR, rate: 0.0001, markPrice: 100 })).resolves.toBe(true)
    expect(ofType(h.events, 'funding_applied')).toEqual([{ type: 'funding_applied', positionId: expect.any(String), amount: expect.closeTo(-0.028, 12), at: T + HOUR }])
    expect(h.engine.snapshot().real.positions[0]?.position.fundingPaid).toBeCloseTo(0.028, 12)
    expect(h.engine.snapshot().accounts.real.saldo).toBeCloseTo(999.972, 9)
    await h.engine.onMarkTick(tick('SOLUSDT', 106, T + 2 * HOUR))
    const [closed] = ofType(h.events, 'position_closed')
    expect(closed?.position.closeReason).toBe('take_profit')
    expect(closed?.position.pnlNet).toBeCloseTo(16.8 - 0.028, 9)
    expect(closed?.position.costs.funding).toBeCloseTo(0.028, 12)
  })

  it('con costos reales: comisiones, spread y slippage desglosados y la cuenta igual al exchange', async () => {
    const settings = settingsWith({ risk: { takerFeeRate: 0.0005, slippageRate: 0.0002 } })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6 }), infos: [infoOf('SOLUSDT', { halfSpreadRate: 0.0001 })] })
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    await h.engine.onMarkTick(tick('SOLUSDT', 96, T + 5 * MIN))
    const [event] = ofType(h.events, 'position_closed')
    const closed = event!.position
    const open = ofType(h.events, 'position_opened')[0]!.fill
    expect(closed.costs.fees).toBeCloseTo(open.fee + event!.fill.fee, 12)
    expect(closed.costs.spread).toBeCloseTo(open.spreadCost + event!.fill.spreadCost, 12)
    expect(closed.costs.slippage).toBeCloseTo(open.slippageCost + event!.fill.slippageCost, 12)
    expect(closed.pnlNet).toBeCloseTo(closed.pnlGross - closed.costs.fees - closed.costs.funding, 12)
    expect(closed.rMultiple).toBeCloseTo(closed.pnlNet / closed.riesgoReal, 12)
    const balance = await h.exchange.getBalance()
    expect(h.engine.snapshot().accounts.real.saldo).toBeCloseTo(balance.total, 9)
    expect(balance.total).toBeCloseTo(1_000 + closed.pnlNet, 9)
  })
})

describe('TradingEngine — datos inválidos del stream', () => {
  it('un tick con precio inválido no rechaza: se ignora, se avisa y la posición sigue igual', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(briefLong()))
    await h.engine.onMarkTick(tick('SOLUSDT', 100.2, T + MIN))
    const before = h.engine.snapshot()
    await expect(h.engine.onMarkTick(tick('SOLUSDT', Number.NaN, T + 2 * MIN))).resolves.toBeUndefined()
    await expect(h.engine.onMarkTick(tick('SOLUSDT', 50, T + 3 * MIN, 0))).resolves.toBeUndefined()
    expect(h.failures).toEqual([
      { operation: 'tick', symbol: 'SOLUSDT', at: T + 2 * MIN, error: expect.any(RangeError) },
      { operation: 'tick', symbol: 'SOLUSDT', at: T + 3 * MIN, error: expect.any(RangeError) },
    ])
    expect(h.engine.snapshot().real).toEqual(before.real)
    expect(ofType(h.events, 'position_closed')).toEqual([])
  })

  it('un funding inválido no rechaza: se ignora, se avisa y devuelve false para que quien lo trajo lo reintente', async () => {
    const { h } = await openSol()
    await expect(h.engine.onFunding({ symbol: 'SOLUSDT', at: T + HOUR, rate: Number.NaN, markPrice: 100 })).resolves.toBe(false)
    expect(h.failures).toEqual([{ operation: 'funding', symbol: 'SOLUSDT', at: T + HOUR, error: expect.any(RangeError) }])
    expect(ofType(h.events, 'funding_applied')).toEqual([])
    expect(h.engine.snapshot().real.positions[0]?.position.fundingPaid).toBe(0)
  })
})

describe('TradingEngine — la pausa sigue cuidando las abiertas', () => {
  it('en pausa todas las decisiones quedan paused pero un tick que cruza el stop cierra igual', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.5, INJUSDT: -0.7 }) })
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    await h.engine.applySettings(settingsWith({ pause: { paused: true, by: 'user', at: null, reason: null } }))
    h.clock.now = T + MIN15 + LATENCY
    const views = [viewOf('SOLUSDT', { t: T + MIN15 }), viewOf('ETHUSDT', { t: T + MIN15 }), viewOf('INJUSDT', { t: T + MIN15 })]
    const { decisions, opened } = await h.engine.onCandleClose(views, NO_CONTEXT)
    expect(opened).toEqual([])
    expect(decisions.map((d) => d.action)).toEqual([
      { kind: 'blocked', reason: 'paused', wantedSide: 'long' },
      { kind: 'blocked', reason: 'paused', wantedSide: 'long' },
      { kind: 'blocked', reason: 'paused', wantedSide: 'short' },
    ])
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 20 * MIN))
    expect(ofType(h.events, 'position_closed').map((e) => e.position.closeReason)).toEqual(['stop'])
  })

  it('en pausa siguen el trailing, la salida por señal y la salida por tiempo', async () => {
    const table: Record<string, number> = { SOLUSDT: 0.6, ETHUSDT: 0.5 }
    const h = harness({ scorer: tableScorer(table) })
    await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT')], NO_CONTEXT)
    await h.engine.applySettings(settingsWith({ pause: { paused: true, by: 'user', at: null, reason: null } }))
    // SOL: 1R = 3 ⇒ con marca 103 el stop pasa a la entrada.
    await h.engine.onMarkTick(tick('SOLUSDT', 103, T + 5 * MIN))
    expect(ofType(h.events, 'stop_moved').map((e) => e.to)).toEqual([100])
    table['SOLUSDT'] = -0.3
    table['ETHUSDT'] = 0.2
    const at49h = T + 49 * HOUR
    h.clock.now = at49h + LATENCY
    const { closed } = await h.engine.onCandleClose([viewOf('SOLUSDT', { t: at49h, price: 102 }), viewOf('ETHUSDT', { t: at49h })], NO_CONTEXT)
    expect(closed.map((c) => [c.symbol, c.closeReason])).toEqual([
      ['SOLUSDT', 'signal_flip'],
      ['ETHUSDT', 'time_exit'],
    ])
  })
})
