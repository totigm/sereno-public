import { describe, expect, it } from 'vitest'
import { initialGuardState } from '../../src/engine/account-guard'
import { runEntries } from '../../src/engine/entries'
import { LearnedPortfolio, type Portfolio, type PortfolioInit, ShadowPortfolio } from '../../src/engine/portfolio'
import type { EngineState } from '../../src/engine/types'
import type { Settings } from '@sereno/shared'
import {
  accountFor,
  compositeOf,
  exchangeFor,
  harness,
  ID_PREFIX,
  infoOf,
  LATENCY,
  MIN,
  MIN15,
  NO_CONTEXT,
  ofType,
  positionOf,
  scenarioLearningState,
  settingsWith,
  stateWith,
  T,
  tableScorer,
  tick,
  viewOf,
} from './fixtures'

// Tope de pérdida del 10% sobre US$ 1.000: el piso es US$ 900.
const LOSS_CAP = 0.1

describe('TradingEngine — tope de pérdida apagado', () => {
  // La corrida de "entradas por confianza" (engine-entries.test.ts), con un stop que salta.
  async function run(settings: Settings) {
    const h = harness({ settings, scorer: tableScorer({ ETHUSDT: 0.4, INJUSDT: -0.5, SOLUSDT: 0.6 }) })
    const cycle = await h.engine.onCandleClose([viewOf('ETHUSDT'), viewOf('INJUSDT'), viewOf('SOLUSDT')], NO_CONTEXT)
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 5 * MIN))
    h.clock.now = T + MIN15 + LATENCY
    await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15 })], NO_CONTEXT)
    return { cycle, events: h.events, snapshot: h.engine.snapshot() }
  }

  it('con lossCap 1 no cambia nada', async () => {
    const base = await run(settingsWith())
    expect(base.cycle.opened.map((p) => [p.symbol, p.side])).toEqual([
      ['SOLUSDT', 'long'],
      ['INJUSDT', 'short'],
      ['ETHUSDT', 'long'],
    ])
    // Ajustes viejos que llegan al motor sin pasar por zod (los fixtures de replay): sin tope.
    const old = settingsWith()
    const withoutCap = await run({ ...old, risk: { ...old.risk, lossCap: undefined as unknown as number } })
    const withCapOff = await run(settingsWith({ risk: { lossCap: 1 } }))
    expect(withoutCap.events).toEqual(base.events)
    expect(withCapOff.events).toEqual(base.events)
    expect(withCapOff.snapshot).toEqual(base.snapshot)
    expect(base.snapshot.real.guard).not.toHaveProperty('lossFloorHit')
    expect(ofType(base.events, 'account_rule').map((e) => e.rule)).not.toContain('loss_floor')
  })
})

describe('TradingEngine — tope de pérdida al abrir', () => {
  // SOL con S′ 0,6: riesgo = saldo × 1% × 0,84 y stop al 3%, sin comisiones.
  function withSaldo(saldo: number) {
    return harness({ settings: settingsWith({ risk: { lossCap: LOSS_CAP } }), saldo, scorer: tableScorer({ SOLUSDT: 0.6 }) })
  }

  it('no abre si el peor caso pasa el piso', async () => {
    // 905 − 7,602 = 897,40: el stop dejaría la cuenta bajo los US$ 900.
    const h = withSaldo(905)
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(opened).toEqual([])
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'loss_floor', wantedSide: 'long' })
    expect(ofType(h.events, 'waited').map((e) => e.phrase)).toEqual(['Miré SOL y esperé: abrirla podía llevarme por debajo del tope de pérdida.'])
    expect(await h.exchange.getPositions()).toEqual([])
  })

  it('abre si el peor caso queda sobre el piso', async () => {
    // 910 − 7,644 = 902,36.
    const h = withSaldo(910)
    const { opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(opened.map((p) => p.symbol)).toEqual(['SOLUSDT'])
  })
})

describe('tope de pérdida al abrir, sólo de lo real', () => {
  // Con US$ 901 sobre US$ 1.000 cualquier stop deja el peor caso bajo el piso de US$ 900.
  const SETTINGS = settingsWith({ risk: { lossCap: LOSS_CAP } })

  async function decideOn(build: (init: PortfolioInit) => Portfolio) {
    const exchange = exchangeFor(SETTINGS, [infoOf('SOLUSDT')], { now: T + LATENCY }, 901)
    exchange.setPrices('SOLUSDT', { mark: 100, last: 100 })
    const portfolio = build({
      exchange,
      account: accountFor(SETTINGS, 1_000, 901),
      guard: initialGuardState(T),
      idPrefix: ID_PREFIX,
      onProtectFailed: () => undefined,
    })
    const outcomes = await runEntries({
      portfolio,
      settings: portfolio.settings(SETTINGS),
      candidates: [{ view: viewOf('SOLUSDT'), composite: compositeOf(0.6) }],
      paused: false,
      gate: null,
      missing: new Set(),
      degraded: new Set(),
      now: T,
      marks: { SOLUSDT: 100 },
      onOpened: () => undefined,
      onFailed: (_symbol, error) => {
        throw error
      },
    })
    return outcomes.get('SOLUSDT')?.action
  }

  it('lo real no abre bajo el piso', async () => {
    expect(await decideOn((init) => new LearnedPortfolio(init, scenarioLearningState(T)))).toEqual({ kind: 'blocked', reason: 'loss_floor', wantedSide: 'long' })
  })

  // La sombra nunca cierra por el tope (`lossFloorPass` es de lo real): tampoco deja de
  // abrir por él, así la comparación con lo aprendido es contra la misma regla de siempre.
  it('la sombra abre igual', async () => {
    expect(await decideOn((init) => new ShadowPortfolio(init, scenarioLearningState(T)))).toMatchObject({ kind: 'enter' })
  })
})

describe('TradingEngine — tope de pérdida en marcha', () => {
  // Apalancamiento 1: cada posición ocupa US$ 200 de margen (el tope por trade) y un hueco
  // de precio la puede llevar mucho más allá de su stop sin liquidarla.
  const SETTINGS = settingsWith({ risk: { lossCap: LOSS_CAP, maxLeverage: 1 } })
  const SCORES = { SOLUSDT: 0.6, ETHUSDT: 0.58, INJUSDT: -0.58 }
  const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'INJUSDT']

  async function gapPastTheFloor() {
    const h = harness({ settings: SETTINGS, scorer: tableScorer(SCORES) })
    const first = await h.engine.onCandleClose(SYMBOLS.map((s) => viewOf(s)), NO_CONTEXT)
    expect(first.opened.map((p) => [p.symbol, p.qty])).toEqual([
      ['SOLUSDT', 2],
      ['ETHUSDT', 2],
      ['INJUSDT', 2],
    ])
    // SOL salta de 100 a 40: el stop en 97 se llena en 40 (−US$ 120) y la cuenta queda en 880.
    await h.engine.onMarkTick(tick('SOLUSDT', 40, T + 5 * MIN))
    return h
  }

  it('al tocar el piso cierra todo y no vuelve a abrir', async () => {
    const h = await gapPastTheFloor()
    const closes = ofType(h.events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason])
    expect(closes).toEqual([
      ['SOLUSDT', 'stop'],
      ['ETHUSDT', 'loss_floor'],
      ['INJUSDT', 'loss_floor'],
    ])
    expect(await h.exchange.getPositions()).toEqual([])
    expect(await h.exchange.getOpenOrders()).toEqual([])
    const rules = ofType(h.events, 'account_rule').filter((e) => e.rule === 'loss_floor')
    expect(rules).toEqual([
      {
        type: 'account_rule',
        at: T + 5 * MIN,
        rule: 'loss_floor',
        phrase: 'Llegué al tope de pérdida: la cuenta quedó en US$ 880,00 y el piso era US$ 900. Cerré todo y me apagué.',
        data: { capitalInicial: 1000, floor: expect.closeTo(900, 9), equity: expect.closeTo(880, 9), closedCount: 2 },
      },
    ])
    expect(ofType(h.events, 'position_closed')[1]?.phrase).toBe('Cerré el long en ETH por el tope de pérdida: US$ 0,00 (0,0R).')

    // El ciclo siguiente no abre: el tope manda antes que la pérdida diaria.
    h.clock.now = T + MIN15 + LATENCY
    const next = await h.engine.onCandleClose(SYMBOLS.map((s) => viewOf(s, { t: T + MIN15 })), NO_CONTEXT)
    expect(next.opened).toEqual([])
    expect(next.decisions.map((d) => d.action)).toEqual([
      { kind: 'blocked', reason: 'loss_floor', wantedSide: 'long' },
      { kind: 'blocked', reason: 'loss_floor', wantedSide: 'long' },
      { kind: 'blocked', reason: 'loss_floor', wantedSide: 'short' },
    ])
    await h.engine.onMarkTick(tick('ETHUSDT', 100, T + MIN15 + MIN))
    expect(ofType(h.events, 'account_rule').filter((e) => e.rule === 'loss_floor')).toHaveLength(1)
  })

  it('el pestillo sobrevive a snapshot/restore', async () => {
    const before = await gapPastTheFloor()
    const snapshot = JSON.parse(JSON.stringify(before.engine.snapshot())) as EngineState & { accounts: { real: { saldo: number } } }
    expect(snapshot.real.guard.lossFloorHit).toBe(true)

    // El saldo de vuelta en US$ 1.000 (otra sesión, misma regla): sin el pestillo abriría.
    const after = harness({ settings: SETTINGS, scorer: tableScorer(SCORES) })
    await after.engine.restore(snapshot)
    after.clock.now = T + MIN15 + LATENCY
    const { decisions, opened } = await after.engine.onCandleClose(SYMBOLS.map((s) => viewOf(s, { t: T + MIN15 })), NO_CONTEXT)
    expect(opened).toEqual([])
    expect(decisions.every((d) => d.action.kind === 'blocked' && d.action.reason === 'loss_floor')).toBe(true)
  })

  it('con el pestillo puesto, una abierta que quedó cierra con el primer precio sin volver a avisar', async () => {
    const h = harness({ settings: SETTINGS, scorer: tableScorer({}) })
    const state = stateWith(positionOf('SOLUSDT'))
    await h.engine.restore({ ...state, real: { ...state.real, guard: { ...state.real.guard, lossFloorHit: true } } })
    await h.engine.onMarkTick(tick('SOLUSDT', 100.5, T + MIN))
    expect(ofType(h.events, 'position_closed').map((e) => e.position.closeReason)).toEqual(['loss_floor'])
    expect(ofType(h.events, 'account_rule')).toEqual([])
  })
})

describe('TradingEngine — tope de pérdida al 100% con plata real', () => {
  // De los US$ 1.000 quedan US$ 1,50 con SOL abierta (0,025 a 100, margen 0,50): un funding de
  // US$ 2,50 lleva la cuenta bajo cero sin que ningún stop dispare.
  async function fundedBelowZero(realMoney: boolean) {
    const h = harness({ settings: settingsWith({ risk: { lossCap: 1 } }), saldo: 1.5, scorer: tableScorer({}), realMoney })
    await h.engine.restore(stateWith(positionOf('SOLUSDT', { margin: 0.5, notional: 2.5, qty: 0.025, riesgoReal: 0.025 })))
    await h.engine.onFunding({ symbol: 'SOLUSDT', at: T + MIN, rate: 1, markPrice: 100 })
    await h.engine.onMarkTick(tick('SOLUSDT', 100, T + 2 * MIN))
    return h
  }

  it('el piso es 0: con la equity en 0 o menos cierra todo', async () => {
    const h = await fundedBelowZero(true)
    expect(ofType(h.events, 'position_closed').map((e) => e.position.closeReason)).toEqual(['loss_floor'])
    expect(ofType(h.events, 'account_rule').map((e) => [e.rule, e.data])).toEqual([['loss_floor', expect.objectContaining({ floor: 0, closedCount: 1 })]])
    expect(h.engine.snapshot().real.guard.lossFloorHit).toBe(true)
  })

  it('en papel, el 100% sigue siendo sin tope', async () => {
    const h = await fundedBelowZero(false)
    expect(ofType(h.events, 'position_closed')).toEqual([])
    expect(ofType(h.events, 'account_rule').map((e) => e.rule)).not.toContain('loss_floor')
  })
})

describe('TradingEngine — tope de pérdida con una abierta todavía sin marca', () => {
  // SOL y ETH abiertas (2 a 100, stop en 99: US$ 2 de riesgo cada una) y sólo llega el precio
  // de SOL. Con plata real, ETH cuenta como si su stop ya se hubiera llenado.
  async function onlySolPriced(saldo: number, realMoney: boolean) {
    const h = harness({ settings: settingsWith({ risk: { lossCap: LOSS_CAP } }), saldo, scorer: tableScorer({}), realMoney })
    await h.engine.restore(stateWith(positionOf('SOLUSDT'), positionOf('ETHUSDT')))
    await h.engine.onMarkTick(tick('SOLUSDT', 100, T + MIN))
    return h
  }

  it('con plata real, si con su stop la equity toca el piso, cierra todo; la que no tiene precio, con el primero', async () => {
    const h = await onlySolPriced(901.5, true)
    expect(ofType(h.events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason])).toEqual([['SOLUSDT', 'loss_floor']])
    expect(ofType(h.events, 'account_rule').map((e) => [e.rule, e.data])).toEqual([['loss_floor', expect.objectContaining({ floor: expect.closeTo(900, 9), equity: expect.closeTo(899.5, 9), closedCount: 1 })]])
    expect(h.engine.snapshot().real.guard.lossFloorHit).toBe(true)

    await h.engine.onMarkTick(tick('ETHUSDT', 100, T + 2 * MIN))
    expect(ofType(h.events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason])).toEqual([
      ['SOLUSDT', 'loss_floor'],
      ['ETHUSDT', 'loss_floor'],
    ])
  })

  it('con plata real, si con su stop queda sobre el piso, no hace nada', async () => {
    const h = await onlySolPriced(903, true)
    expect(ofType(h.events, 'position_closed')).toEqual([])
    expect(h.engine.snapshot().real.guard.lossFloorHit).toBeFalsy()
  })

  it('en papel espera a tener todas las marcas, como antes', async () => {
    const h = await onlySolPriced(901.5, false)
    expect(ofType(h.events, 'position_closed')).toEqual([])
    expect(h.engine.snapshot().real.guard.lossFloorHit).toBeFalsy()
  })
})
