import { describe, expect, it } from 'vitest'
import { Account } from '../../src/capital/account'
import { initialGuardState } from '../../src/engine/account-guard'
import { TradingEngine } from '../../src/engine/engine'
import type { EngineFailure, EngineState } from '../../src/engine/types'
import {
  exchangeFor,
  harness,
  ID_PREFIX,
  infoOf,
  LATENCY,
  MIN,
  NO_CONTEXT,
  ofType,
  positionOf,
  rethrowFailure,
  settingsWith,
  stateWith,
  SYMBOLS,
  T,
  tableScorer,
  tick,
  viewOf, scenarioLearningState } from './fixtures'

// Lo que el runtime en vivo necesita del motor: retomar una pausa por drawdown que Toti
// levantó con el bot apagado, enterarse de las órdenes que el exchange rechaza, volver a
// usar el capital blindado y cerrar las abiertas cuyo stop quedó atrás durante un hueco.

const AUTO_PAUSE = { paused: true, by: 'auto' as const, at: null, reason: 'drawdown' }

function drawdownState(overrides: Partial<EngineState['real']['guard']> = {}): EngineState {
  const state = stateWith()
  return { ...state, real: { ...state.real, guard: { ...initialGuardState(T), drawdownPaused: true, equityPeak: 1_200, ...overrides } } }
}

describe('TradingEngine.restore — pausa por drawdown que Toti levantó con el bot apagado', () => {
  it('con los ajustes ya sin pausa, la pausa por drawdown se levanta y el pico se vuelve a medir', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    await h.engine.restore(drawdownState())
    expect(h.engine.snapshot().real.guard).toMatchObject({ drawdownPaused: false, equityPeak: null })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.action.kind).toBe('enter')
  })

  it('con los ajustes todavía en pausa sigue pausado y se levanta cuando Toti reanuda', async () => {
    const h = harness({ settings: settingsWith({ pause: AUTO_PAUSE }), scorer: tableScorer({ SOLUSDT: 0.6 }) })
    await h.engine.restore(drawdownState())
    expect(h.engine.snapshot().real.guard).toMatchObject({ drawdownPaused: true, equityPeak: 1_200 })
    await h.engine.applySettings(settingsWith())
    expect(h.engine.snapshot().real.guard).toMatchObject({ drawdownPaused: false, equityPeak: null })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.action.kind).toBe('enter')
  })

  it('sin pausa por drawdown restaurada, el pico de equity queda como estaba', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(drawdownState({ drawdownPaused: false }))
    expect(h.engine.snapshot().real.guard).toMatchObject({ drawdownPaused: false, equityPeak: 1_200 })
  })
})

describe('TradingEngine — órdenes de stop y take profit rechazadas', () => {
  it('un stop rechazado se informa por onFailure una vez por racha, y cuando el exchange vuelve a aceptar se coloca', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const placeStop = h.exchange.placeStopMarket.bind(h.exchange)
    const rejected = new Error('el exchange rechazó el stop')
    h.exchange.placeStopMarket = async () => {
      throw rejected
    }
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    h.clock.now = T + MIN
    await h.engine.onMarkTick(tick('SOLUSDT', 100.4, T + MIN))
    expect(h.failures).toEqual<EngineFailure[]>([
      { operation: 'protect', order: 'stop', portfolio: 'real', symbol: 'SOLUSDT', at: T + LATENCY, error: rejected },
    ])
    h.exchange.placeStopMarket = placeStop
    await h.engine.onMarkTick(tick('SOLUSDT', 100.2, T + 2 * MIN))
    expect(h.engine.snapshot().real.positions[0]?.position.stopOrderId).not.toBeNull()
    // Stop en 97 (d 3%): la marca 96,9 lo cruza y el exchange lo dispara.
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 3 * MIN))
    expect(ofType(h.events, 'position_closed').map((e) => e.position.closeReason)).toEqual(['stop'])
    expect(h.failures).toHaveLength(1)
  })

  it('un take profit rechazado también se informa; sin stop en el exchange la marca que lo cruza cierra por el respaldo', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    h.exchange.placeStopMarket = async () => {
      throw new Error('stop rechazado')
    }
    h.exchange.placeTakeProfitMarket = async () => {
      throw new Error('take profit rechazado')
    }
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(h.failures.map((f) => (f.operation === 'protect' ? f.order : f.operation))).toEqual(['stop', 'take_profit'])
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + MIN))
    expect(ofType(h.events, 'position_closed').map((e) => [e.position.closeReason, e.position.exitPrice])).toEqual([['stop', 96.9]])
    expect(h.failures).toHaveLength(2)
  })
})

describe('TradingEngine.releaseProtected — volver a usar el capital blindado', () => {
  it('protegido vuelve a 0 y la base del blindaje pasa a ser el saldo; sin blindaje no toca nada', async () => {
    const settings = settingsWith()
    const clock = { now: T + LATENCY }
    const engine = new TradingEngine({
      exchange: exchangeFor(settings, SYMBOLS.map((s) => infoOf(s)), clock, 1_800),
      account: new Account({ capitalInicial: 1_000, saldo: 1_800, protegido: 1_000, baseBlindaje: 1_000, reinvest: true, protectPct: 0.7, onShield: 'reduce' }),
      settings,
      learning: scenarioLearningState(T),
      clock: () => clock.now,
      sink: () => undefined,
      onFailure: rethrowFailure,
      idPrefix: ID_PREFIX,
    })
    expect(await engine.releaseProtected()).toEqual({ released: true })
    expect(engine.snapshot().accounts.real).toMatchObject({ protegido: 0, baseBlindaje: 1_800, capitalBase: 1_800 })
    expect(await engine.releaseProtected()).toEqual({ released: false, reason: 'not_shielded' })
  })
})

describe('TradingEngine.reconcile — retomar después de un hueco', () => {
  it('una abierta cuyo stop quedó atrás se cierra al precio actual con stop_missed_offline, en lo real y en la sombra', async () => {
    const h = harness({ scorer: tableScorer({}), shadow: true })
    const state = stateWith(positionOf('SOLUSDT'), positionOf('ETHUSDT'))
    const shadowSol = { position: positionOf('SOLUSDT', { id: 'shadow-SOLUSDT-restored', shadow: true }), entryCosts: { spread: 0, slippage: 0 }, tickSize: 0.01 }
    await h.engine.restore({ ...state, shadow: { positions: [shadowSol], guard: initialGuardState(T), learning: scenarioLearningState(T) } })
    h.clock.now = T + 5 * MIN
    // SOL long con stop en 99: la marca actual 98,5 ya lo pasó. ETH sigue arriba del suyo.
    const closed = await h.engine.reconcile([tick('SOLUSDT', 98.5, T + 5 * MIN), tick('ETHUSDT', 99.5, T + 5 * MIN)])
    expect(closed.map((c) => [c.symbol, c.shadow, c.closeReason, c.exitPrice])).toEqual([
      ['SOLUSDT', false, 'stop_missed_offline', 98.5],
      ['SOLUSDT', true, 'stop_missed_offline', 98.5],
    ])
    expect(ofType(h.events, 'position_closed')[0]?.phrase).toBe(
      'Cerré el long en SOL al reconectar: el stop había quedado atrás mientras estaba sin conexión (−US$ 3,00).',
    )
    expect(h.engine.snapshot().real.positions.map((s) => s.position.symbol)).toEqual(['ETHUSDT'])
    // ETH no se tocó: el tick siguiente le vuelve a colocar stop y take profit.
    await h.engine.onMarkTick(tick('ETHUSDT', 99.6, T + 6 * MIN))
    expect((await h.exchange.getOpenOrders('ETHUSDT')).map((o) => o.type).sort()).toEqual(['STOP_MARKET', 'TAKE_PROFIT_MARKET'])
  })

  it('un tick inválido se informa y no cierra nada', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(positionOf('SOLUSDT')))
    expect(await h.engine.reconcile([tick('SOLUSDT', Number.NaN, T + MIN)])).toEqual([])
    expect(h.failures.map((f) => f.operation)).toEqual(['tick'])
    expect(ofType(h.events, 'position_closed')).toEqual([])
  })
})
