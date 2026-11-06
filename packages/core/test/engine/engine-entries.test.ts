import { describe, expect, it } from 'vitest'
import { Account } from '../../src/capital/account'
import { TradingEngine } from '../../src/engine/engine'
import { exchangeFor, harness, infoOf, LATENCY, MIN15, NO_CONTEXT, ofType, settingsWith, SYMBOLS, T, tableScorer, viewOf } from './fixtures'

// Tres vistas en el orden en que llegan; por confianza el orden es SOL, INJ, ETH.
const SCORES = { ETHUSDT: 0.4, INJUSDT: -0.5, SOLUSDT: 0.6 }
const VIEWS = () => [viewOf('ETHUSDT'), viewOf('INJUSDT'), viewOf('SOLUSDT')]

describe('TradingEngine — entradas por confianza', () => {
  it('con S′ 0,6, 0,4 y −0,5 y θ 0,35 abre primero la de 0,6 y después por confianza', async () => {
    const h = harness({ scorer: tableScorer(SCORES) })
    const result = await h.engine.onCandleClose(VIEWS(), NO_CONTEXT)
    expect(result.opened.map((p) => [p.symbol, p.side])).toEqual([
      ['SOLUSDT', 'long'],
      ['INJUSDT', 'short'],
      ['ETHUSDT', 'long'],
    ])
    expect(ofType(h.events, 'position_opened').map((e) => e.position.symbol)).toEqual(['SOLUSDT', 'INJUSDT', 'ETHUSDT'])
  })

  it('con maxPositions 2 la tercera por confianza queda max_positions', async () => {
    const h = harness({ settings: settingsWith({ risk: { maxPositions: 2 } }), scorer: tableScorer(SCORES) })
    const { decisions, opened } = await h.engine.onCandleClose(VIEWS(), NO_CONTEXT)
    expect(opened.map((p) => p.symbol)).toEqual(['SOLUSDT', 'INJUSDT'])
    expect(decisions.find((d) => d.symbol === 'ETHUSDT')?.action).toEqual({ kind: 'blocked', reason: 'max_positions', wantedSide: 'long' })
  })

  it('el tamaño sale del plan: riesgo 1% × (0,6 + 0,4·c), stop a k·ATR, apalancamiento por el stop', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    const action = decisions[0]?.action
    expect(action?.kind).toBe('enter')
    if (action?.kind !== 'enter') return
    expect(action.plan).toMatchObject({ side: 'long', price: 100, distanciaStop: 0.03, leverage: 5, qty: 2.8, stopPrice: 97, takeProfitPrice: 106, theta: 0.35 })
    expect(action.plan.riesgoUsd).toBeCloseTo(8.4, 12)
    expect(action.plan.multipliers).toEqual({ confidence: 0.84, symbol: 1, btc: 1 })
    const [position] = opened
    expect(position).toMatchObject({
      symbol: 'SOLUSDT',
      side: 'long',
      leverage: 5,
      qty: 2.8,
      entryPrice: 100,
      margin: 56,
      stopPrice: 97,
      takeProfitPrice: 106,
      thetaAtOpen: 0.35,
      trailingActive: false,
      bestPrice: 100,
      openedAt: T + LATENCY,
      shadow: false,
      mode: 'auto',
    })
    expect(position?.riesgoReal).toBeCloseTo(8.4, 12)
    expect(position?.distanciaStop).toBeCloseTo(0.03, 12)
  })

  it('cada apertura emite position_opened con su frase y deja stop y take profit en el exchange', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6, INJUSDT: -0.5 }) })
    await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('INJUSDT')], NO_CONTEXT)
    const opened = ofType(h.events, 'position_opened')
    expect(opened.map((e) => e.phrase)).toEqual([
      'Abrí un long 5x en SOL con US$ 56. La tendencia en 1h y 4h acompaña y el funding está negativo.',
      'Abrí un short 5x en INJ con US$ 53,32. La tendencia en 1h y 4h acompaña y el funding está positivo.',
    ])
    expect(opened.every((e) => e.position.openReason === e.phrase)).toBe(true)
    const orders = await h.exchange.getOpenOrders()
    expect(orders.map((o) => [o.symbol, o.type, o.side, o.stopPrice])).toEqual([
      ['SOLUSDT', 'STOP_MARKET', 'sell', 97],
      ['SOLUSDT', 'TAKE_PROFIT_MARKET', 'sell', 106],
      ['INJUSDT', 'STOP_MARKET', 'buy', 103],
      ['INJUSDT', 'TAKE_PROFIT_MARKET', 'buy', 94],
    ])
    const [sol, inj] = opened.map((e) => e.position)
    expect([sol?.stopOrderId, sol?.tpOrderId, inj?.stopOrderId, inj?.tpOrderId]).toEqual(orders.map((o) => o.id))
  })

  it('la comisión de apertura queda realizada en la cuenta igual que en el exchange', async () => {
    const h = harness({ settings: settingsWith({ risk: { takerFeeRate: 0.0005 } }), scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const { opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(opened[0]?.feesPaid).toBeCloseTo(0.14, 12)
    const balance = await h.exchange.getBalance()
    expect(h.account.snapshot(opened, {}).saldo).toBeCloseTo(balance.total, 9)
    expect(balance.total).toBeCloseTo(999.86, 9)
  })
})

describe('TradingEngine — una decisión por vista', () => {
  it('decisions trae una fila por vista, con las que esperan y las bloqueadas', async () => {
    const h = harness({ settings: settingsWith({ risk: { maxPositions: 1 } }), scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.5, INJUSDT: 0.1 }) })
    const views = [viewOf('SOLUSDT'), viewOf('ETHUSDT'), viewOf('INJUSDT')]
    const { decisions } = await h.engine.onCandleClose(views, NO_CONTEXT)
    expect(decisions.map((d) => [d.symbol, d.action.kind])).toEqual([
      ['SOLUSDT', 'enter'],
      ['ETHUSDT', 'blocked'],
      ['INJUSDT', 'wait'],
    ])
    expect(decisions.every((d) => d.t === T)).toBe(true)
    const [event] = ofType(h.events, 'decisions')
    expect(event).toEqual({ type: 'decisions', t: T, decisions })
    expect(h.events.at(-1)?.type).toBe('decisions')
  })

  it('|S′| < θ ⇒ wait sin pasar por los filtros (aunque la moneda esté degradada)', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.2, ETHUSDT: 0.6 }) })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT')], { missingSymbols: [], degraded: ['SOLUSDT', 'ETHUSDT'] })
    expect(decisions.map((d) => d.action)).toEqual([
      { kind: 'wait' },
      { kind: 'blocked', reason: 'degraded', wantedSide: 'long' },
    ])
  })

  it('una moneda cuya vela no llegó queda no_candle aunque su S′ (viejo) no pase θ', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.1, ETHUSDT: -0.6 }) })
    const views = [viewOf('SOLUSDT', { withoutDecisionCandle: true }), viewOf('ETHUSDT', { withoutDecisionCandle: true })]
    const { decisions } = await h.engine.onCandleClose(views, { missingSymbols: ['SOLUSDT', 'ETHUSDT'], degraded: [] })
    expect(decisions.map((d) => d.action)).toEqual([
      { kind: 'blocked', reason: 'no_candle', wantedSide: null },
      { kind: 'blocked', reason: 'no_candle', wantedSide: 'short' },
    ])
  })

  it('una sola posición por moneda: con una abierta, la decisión es has_position', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    h.clock.now = T + MIN15 + LATENCY
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15 })], NO_CONTEXT)
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'has_position', wantedSide: 'long' })
  })

  it('modo custom: tamaño fijo, SL/TP en % del precio y dirección restringida', async () => {
    const settings = settingsWith({ mode: 'custom', custom: { marginPerTrade: { kind: 'usd', value: 50 }, leverage: 5, slPct: 0.02, tpPct: 0.04, direction: 'long' } })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6, INJUSDT: -0.6 }) })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('INJUSDT')], NO_CONTEXT)
    expect(opened[0]).toMatchObject({ symbol: 'SOLUSDT', mode: 'custom', margin: 50, notional: 250, qty: 2.5, stopPrice: 98, takeProfitPrice: 104 })
    expect(opened[0]?.riesgoReal).toBeCloseTo(5, 12)
    expect(decisions[1]?.action).toEqual({ kind: 'blocked', reason: 'direction_not_allowed', wantedSide: 'short' })
  })

  it('sin scorer inyectado usa el compuesto real de las diez señales', async () => {
    const h = harness({ scorer: tableScorer({}) })
    const { scorer: _injected, ...deps } = h.deps
    const engine = new TradingEngine(deps)
    const { decisions } = await engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.composite.signals).toHaveLength(10)
  })
})

describe('TradingEngine — en pausa no se evalúan entradas', () => {
  it('todas las monedas quedan paused, aun las que no pasan θ y las que no tienen vela', async () => {
    const h = harness({ settings: settingsWith({ pause: { paused: true, by: 'user' } }), scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.1, INJUSDT: -0.5 }) })
    const views = [viewOf('SOLUSDT'), viewOf('ETHUSDT'), viewOf('INJUSDT', { withoutDecisionCandle: true })]
    const { decisions, opened } = await h.engine.onCandleClose(views, { missingSymbols: ['INJUSDT'], degraded: [] })
    expect(opened).toEqual([])
    expect(decisions.map((d) => d.action)).toEqual([
      { kind: 'blocked', reason: 'paused', wantedSide: 'long' },
      { kind: 'blocked', reason: 'paused', wantedSide: null },
      { kind: 'blocked', reason: 'paused', wantedSide: 'short' },
    ])
  })
})

describe('TradingEngine — rechazos y fallas del exchange al abrir', () => {
  it('saldo insuficiente en el exchange ⇒ insufficient_capital, sin falla', async () => {
    const settings = settingsWith()
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6 }) })
    // La cuenta cree tener US$ 1.000; la billetera del exchange tiene 50 y el margen pedido es 56.
    const engine = new TradingEngine({ ...h.deps, exchange: exchangeFor(settings, SYMBOLS.map((s) => infoOf(s)), h.clock, 50), account: new Account({ capitalInicial: 1_000, reinvest: true, protectPct: 0.7, onShield: 'reduce' }) })
    const { decisions, opened } = await engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(opened).toEqual([])
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'insufficient_capital', wantedSide: 'long' })
    expect(h.failures).toEqual([])
  })

  it('el nocional al precio del fill queda bajo el mínimo ⇒ below_min_notional, no "falta capital"', async () => {
    // Custom: US$ 10 a 5x = 50 de nocional, justo el mínimo al último precio; el short vende
    // medio spread más abajo y el nocional del fill queda en 49,995.
    const settings = settingsWith({ mode: 'custom', custom: { marginPerTrade: { kind: 'usd', value: 10 }, leverage: 5, slPct: 0.02, tpPct: 0.04, direction: 'both' } })
    const info = infoOf('INJUSDT', { minNotional: 50, halfSpreadRate: 0.0001 })
    const h = harness({ settings, scorer: tableScorer({ INJUSDT: -0.6 }), infos: [info] })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('INJUSDT', { info })], NO_CONTEXT)
    expect(opened).toEqual([])
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'below_min_notional', wantedSide: 'short' })
    expect(ofType(h.events, 'waited').map((e) => e.reason)).toEqual(['below_min_notional'])
    expect(h.failures).toEqual([])
  })

  it('una moneda que el simulador no conoce no frena el ciclo: se avisa la falla y las demás entran', async () => {
    // SUI llegó al universo después de crear el simulador (sólo conoce SOL y ETH).
    const h = harness({ scorer: tableScorer({ SUIUSDT: 0.7, SOLUSDT: 0.6 }), infos: [infoOf('SOLUSDT'), infoOf('ETHUSDT')] })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SUIUSDT'), viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions.map((d) => d.action)).toEqual([{ kind: 'blocked', reason: 'degraded', wantedSide: 'long' }, expect.objectContaining({ kind: 'enter' })])
    expect(opened.map((p) => p.symbol)).toEqual(['SOLUSDT'])
    expect(h.failures).toEqual([{ operation: 'open', portfolio: 'real', symbol: 'SUIUSDT', at: T + LATENCY, error: expect.any(Error) }])
    expect(ofType(h.events, 'decisions')).toHaveLength(1)
    expect(ofType(h.events, 'waited')).toEqual([])
  })
})

describe('TradingEngine — "esperé" en el diario', () => {
  it('un bloqueo por filtro emite waited con su frase, como máximo una vez por moneda cada 4 horas', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const ctx = { missingSymbols: [], degraded: ['SOLUSDT'] }
    await h.engine.onCandleClose([viewOf('SOLUSDT')], ctx)
    h.clock.now = T + MIN15 + LATENCY
    await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15 })], ctx)
    const later = T + 16 * MIN15
    h.clock.now = later + LATENCY
    await h.engine.onCandleClose([viewOf('SOLUSDT', { t: later })], ctx)
    expect(ofType(h.events, 'waited')).toEqual([
      { type: 'waited', t: T, symbol: 'SOLUSDT', reason: 'degraded', phrase: 'Miré SOL y esperé: me faltan datos de SOL.' },
      { type: 'waited', t: later, symbol: 'SOLUSDT', reason: 'degraded', phrase: 'Miré SOL y esperé: me faltan datos de SOL.' },
    ])
  })

  it('las pausas de cuenta, la vela faltante y la posición abierta no llenan el diario de "esperé"', async () => {
    const h = harness({ settings: settingsWith({ pause: { paused: true, by: 'user' } }), scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.6 }) })
    await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT')], { missingSymbols: ['ETHUSDT'], degraded: [] })
    expect(ofType(h.events, 'waited')).toEqual([])
  })
})
