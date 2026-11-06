import { describe, expect, it } from 'vitest'
import { Account } from '../../src/capital/account'
import { TradingEngine } from '../../src/engine/engine'
import type { CycleContext } from '../../src/engine/types'
import type { EngineEvent, LearningState, SymbolInfo } from '../../src/types'
import { signalRecord } from '../../src/learning/state'
import {
  DAY,
  exchangeFor,
  harness,
  HOUR,
  ID_PREFIX,
  infoOf,
  LATENCY,
  MIN,
  MIN15,
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
  viewOf,
  weightedScorer, scenarioLearningState } from './fixtures'

async function cycleAt(h: ReturnType<typeof harness>, t: number, symbols: string[], ctx: CycleContext = NO_CONTEXT, info: (symbol: string) => SymbolInfo = infoOf) {
  h.clock.now = t + LATENCY
  return h.engine.onCandleClose(
    symbols.map((s) => viewOf(s, { t, info: info(s) })),
    ctx,
  )
}

describe('TradingEngine — pérdida diaria (día de Buenos Aires)', () => {
  it('al llegar al límite avisa y no abre nada hasta las 00:00 de Buenos Aires', async () => {
    const h = harness({ settings: settingsWith({ risk: { dailyLossLimit: 0.005 } }), scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.6 }) })
    await cycleAt(h, T, ['SOLUSDT'])
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 5 * MIN))
    expect(ofType(h.events, 'account_rule')).toEqual([
      { type: 'account_rule', at: T + 5 * MIN, rule: 'daily_loss', phrase: 'Perdí US$ 8,68 hoy y llegué al límite del 0,5% diario: no abro nada hasta mañana.', data: { todayRealized: expect.closeTo(-8.68, 9), limitPct: 0.005 } },
    ])
    const sameDay = await cycleAt(h, T + MIN15, ['ETHUSDT'])
    expect(sameDay.decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'daily_loss', wantedSide: 'long' })
    // 23:45 en Buenos Aires: el día UTC ya cambió, el de Buenos Aires no.
    const lateNight = await cycleAt(h, Date.UTC(2026, 10, 1, 2, 45), ['ETHUSDT'])
    expect(lateNight.decisions[0]?.action).toMatchObject({ kind: 'blocked', reason: 'daily_loss' })
    const nextDay = await cycleAt(h, Date.UTC(2026, 10, 1, 3, 15), ['ETHUSDT'])
    expect(nextDay.decisions[0]?.action.kind).toBe('enter')
    expect(ofType(h.events, 'account_rule')).toHaveLength(1)
  })
})

describe('TradingEngine — drawdown', () => {
  it('pausa sola al caer desde el pico y sólo vuelve a operar cuando Toti reanuda', async () => {
    const paused = { paused: true, by: 'auto' as const, at: null, reason: 'drawdown' }
    const settings = settingsWith({ risk: { maxDrawdown: 0.005 } })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.6 }) })
    await cycleAt(h, T, ['SOLUSDT'])
    await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 5 * MIN))
    expect(ofType(h.events, 'account_rule').map((e) => e.phrase)).toEqual([
      'Me pausé solo: el capital cayó un 0,9% desde el pico (de US$ 1.000 a US$ 991,32). Lo reanudás vos cuando quieras.',
    ])
    expect((await cycleAt(h, T + MIN15, ['ETHUSDT'])).decisions[0]?.action).toMatchObject({ reason: 'drawdown_pause' })
    await h.engine.applySettings(settingsWith({ risk: { maxDrawdown: 0.005 }, pause: paused }))
    await h.engine.applySettings(settings)
    expect((await cycleAt(h, T + 2 * MIN15, ['ETHUSDT'])).decisions[0]?.action.kind).toBe('enter')
  })
})

describe('TradingEngine — una pausa manual no toca el pico de equity', () => {
  it('pausar y reanudar sin drawdown conserva el pico: la caída se sigue midiendo desde el pico real', async () => {
    const settings = settingsWith({ risk: { maxDrawdown: 0.009 } })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.6 }) })
    await cycleAt(h, T, ['SOLUSDT'])
    // SOL long en 100 con 2,8: a 102,9 (sin llegar a +1R) el equity marca el pico, 1.008,12.
    h.clock.now = T + MIN15 + LATENCY
    await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15, price: 102.9 })], NO_CONTEXT)
    expect(h.engine.snapshot().real.guard.equityPeak).toBeCloseTo(1_008.12, 9)
    await h.engine.applySettings(settingsWith({ risk: { maxDrawdown: 0.009 }, pause: { paused: true, by: 'user', at: null, reason: null } }))
    await h.engine.applySettings(settings)
    // A 99,5 el equity es 998,60: 0,94% abajo del pico real (con el pico borrado no habría corte).
    h.clock.now = T + 2 * MIN15 + LATENCY
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + 2 * MIN15, price: 99.5 }), viewOf('ETHUSDT', { t: T + 2 * MIN15 })], NO_CONTEXT)
    expect(ofType(h.events, 'account_rule')).toEqual([
      expect.objectContaining({ rule: 'drawdown', data: { peak: expect.closeTo(1_008.12, 9), equity: expect.closeTo(998.6, 9) } }),
    ])
    expect(decisions[1]?.action).toEqual({ kind: 'blocked', reason: 'drawdown_pause', wantedSide: 'long' })
  })
})

describe('TradingEngine — drawdown de la sombra', () => {
  // Con los pesos aprendidos ninguna llega a θ (0,35); con pesos 1, sí (S = 0,6, sobre el θ 0,55 por defecto de la sombra): sólo opera la sombra.
  const learned: LearningState = { ...scenarioLearningState(T), weightsGlobal: { ...signalRecord(1), trend15m: 2, momentum: 0.2 } }
  const signals = { trend15m: 0.2, momentum: 1 }

  it('la sombra no se queda pausada por su drawdown: lo avisa marcado como sombra y sigue operando', async () => {
    const h = harness({ settings: settingsWith({ risk: { maxDrawdown: 0.005 } }), learning: learned, scorer: weightedScorer({ SOLUSDT: signals, ETHUSDT: signals }), shadow: true })
    await cycleAt(h, T, ['SOLUSDT'])
    // La sombra abrió SOL con el stop en 96 (k 2 por defecto): tocado a 95,9 pierde 8,61.
    await h.engine.onMarkTick(tick('SOLUSDT', 95.9, T + 5 * MIN))
    expect(ofType(h.events, 'account_rule')).toEqual([
      {
        type: 'account_rule',
        at: T + 5 * MIN,
        rule: 'drawdown',
        shadow: true,
        phrase: 'La sombra cayó un 0,9% desde su pico (de US$ 1.000 a US$ 991,39). No la pauso: sigue operando para que la comparación con lo aprendido no se corte.',
        data: { peak: 1_000, equity: expect.closeTo(991.39, 9) },
      },
    ])
    expect(h.engine.snapshot().shadow?.guard).toMatchObject({ drawdownPaused: false, equityPeak: expect.closeTo(991.39, 9) })
    // Un ciclo y tres días después la sombra sigue entrando (SOL queda en enfriamiento por la pérdida).
    const next = await cycleAt(h, T + MIN15, ['SOLUSDT', 'ETHUSDT'])
    expect(next.decisions.map((d) => d.shadow?.action)).toEqual(['blocked', 'enter'])
    const later = await cycleAt(h, T + 3 * DAY, ['SOLUSDT'])
    expect(later.decisions[0]?.shadow?.action).toBe('enter')
    expect(ofType(h.events, 'account_rule')).toHaveLength(1)
  })
})

describe('TradingEngine — blindaje del capital inicial', () => {
  it('al llegar a la ganancia pedida blinda, cierra lo que no entra en lo ganado y lo dice', async () => {
    const settings = settingsWith({ capital: { protectPct: 0.005, onShield: 'reduce' } })
    const bigMinimum = (symbol: string) => infoOf(symbol, { minNotional: 100 })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.5 }), infos: SYMBOLS.map(bigMinimum) })
    await cycleAt(h, T, ['SOLUSDT', 'ETHUSDT'], NO_CONTEXT, bigMinimum)
    // SOL llega al take profit: +6 × 2,8 = +16,80 realizado, ETH sin moverse.
    await h.engine.onMarkTick(tick('SOLUSDT', 106, T + 5 * MIN))
    const closes = ofType(h.events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason])
    expect(closes).toEqual([
      ['SOLUSDT', 'take_profit'],
      ['ETHUSDT', 'shield_reduce'],
    ])
    expect(ofType(h.events, 'account_rule')).toEqual([
      {
        type: 'account_rule',
        at: T + 5 * MIN,
        rule: 'shield',
        phrase: 'Blindé los US$ 1.000 iniciales: de acá en más opero sólo con la ganancia (US$ 16,80). Cerré 1 posición para que entre en lo ganado.',
        data: { capitalInicial: 1_000, baseBlindaje: 1_000, ganancia: expect.closeTo(16.8, 9), closedCount: 1 },
      },
    ])
    expect(h.engine.snapshot().accounts.real).toMatchObject({ protegido: 1_000, capitalBase: expect.closeTo(16.8, 9) })
    // Con US$ 16,80 no alcanza el margen mínimo (100 / 5x = 20): se pausa sola una vez.
    await cycleAt(h, T + MIN15, ['SOLUSDT', 'ETHUSDT'], NO_CONTEXT, bigMinimum)
    await cycleAt(h, T + 2 * MIN15, ['SOLUSDT', 'ETHUSDT'], NO_CONTEXT, bigMinimum)
    expect(ofType(h.events, 'account_rule').slice(1)).toEqual([
      { type: 'account_rule', at: T + MIN15 + LATENCY, rule: 'shield_insufficient', phrase: 'Me pausé solo: los US$ 1.000 están blindados y no queda ganancia para operar.', data: { baseBlindaje: 1_000 } },
    ])
  })

  it('con alBlindar "cerrar todo" cierra todas las abiertas al blindar y lo dice', async () => {
    const settings = settingsWith({ capital: { protectPct: 0.005, onShield: 'closeAll' } })
    const h = harness({ settings, scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.5, INJUSDT: -0.5 }) })
    await cycleAt(h, T, ['SOLUSDT', 'ETHUSDT', 'INJUSDT'])
    await h.engine.onMarkTick(tick('SOLUSDT', 106, T + 5 * MIN))
    expect(ofType(h.events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason])).toEqual([
      ['SOLUSDT', 'take_profit'],
      ['ETHUSDT', 'shield_reduce'],
      ['INJUSDT', 'shield_reduce'],
    ])
    expect(ofType(h.events, 'account_rule').map((e) => [e.rule, e.phrase])).toEqual([
      ['shield', 'Blindé los US$ 1.000 iniciales: de acá en más opero sólo con la ganancia (US$ 16,80). Cerré 2 posiciones para que entren en lo ganado.'],
    ])
    expect(h.engine.snapshot().real.positions).toEqual([])
    expect(await h.exchange.getPositions()).toEqual([])
  })

  it('con la marca de una abierta faltante no evalúa el blindaje; con todas las marcas, sí', async () => {
    const settings = settingsWith({ capital: { protectPct: 0.005 } })
    const clock = { now: T }
    const events: EngineEvent[] = []
    // Ya ganó US$ 20 realizados; las dos abiertas se restauran sin precio.
    const engine = new TradingEngine({
      exchange: exchangeFor(settings, SYMBOLS.map((s) => infoOf(s)), clock, 1_020),
      account: new Account({ capitalInicial: 1_000, saldo: 1_020, reinvest: true, protectPct: 0.005, onShield: 'keep' }),
      settings,
      learning: scenarioLearningState(T),
      clock: () => clock.now,
      sink: (e) => events.push(e),
      onFailure: rethrowFailure,
      idPrefix: ID_PREFIX,
      scorer: tableScorer({}),
    })
    await engine.restore(stateWith(positionOf('SOLUSDT'), positionOf('ETHUSDT')))
    await engine.onMarkTick(tick('SOLUSDT', 100, T + MIN))
    expect(ofType(events, 'account_rule')).toEqual([])
    await engine.onMarkTick(tick('ETHUSDT', 100, T + 2 * MIN))
    expect(ofType(events, 'account_rule').map((e) => e.rule)).toEqual(['shield'])
  })
})

describe('TradingEngine — cierres pedidos y deslistados', () => {
  it('closePosition cierra a mercado con el motivo pedido; sin posición devuelve null', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }) })
    await cycleAt(h, T, ['SOLUSDT'])
    h.clock.now = T + HOUR
    const closed = await h.engine.closePosition('SOLUSDT', 'manual')
    expect(closed).toMatchObject({ symbol: 'SOLUSDT', closeReason: 'manual', exitPrice: 100, closedAt: T + HOUR })
    expect(ofType(h.events, 'position_closed')[0]?.phrase).toBe('Cerré el long en SOL porque me lo pediste: US$ 0,00 (0,0R).')
    expect(await h.engine.closePosition('SOLUSDT', 'manual')).toBeNull()
  })

  it('closeAll cierra todas las reales y deja la sombra', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: -0.58 }), shadow: true })
    await cycleAt(h, T, ['SOLUSDT', 'ETHUSDT'])
    const closed = await h.engine.closeAll('close_all')
    expect(closed.map((c) => [c.symbol, c.closeReason, c.shadow])).toEqual([
      ['SOLUSDT', 'close_all', false],
      ['ETHUSDT', 'close_all', false],
    ])
    expect(h.engine.snapshot().shadow?.positions.map((s) => s.position.symbol)).toEqual(['SOLUSDT', 'ETHUSDT'])
  })

  it('un contrato deslistado se cierra con motivo delisted en las dos carteras', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }), shadow: true })
    await cycleAt(h, T, ['SOLUSDT'])
    const { closed, opened, decisions } = await cycleAt(h, T + MIN15, ['SOLUSDT'], { missingSymbols: [], degraded: [], delisted: ['SOLUSDT'] })
    expect(closed.map((c) => [c.closeReason, c.shadow])).toEqual([
      ['delisted', false],
      ['delisted', true],
    ])
    // Un contrato que se deslista no se vuelve a abrir aunque la señal siga.
    expect(opened).toEqual([])
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'degraded', wantedSide: 'long' })
  })
})

describe('TradingEngine — la cuenta sigue a la billetera', () => {
  it('un cierre a mercado que pierde más que el saldo realiza sólo lo que la billetera pudo cubrir', async () => {
    const settings = settingsWith()
    const clock = { now: T }
    const events: EngineEvent[] = []
    // Todo el capital está en la posición: billetera 40 = margen 40, sin saldo libre.
    const exchange = exchangeFor(settings, SYMBOLS.map((s) => infoOf(s)), clock, 40)
    const account = new Account({ capitalInicial: 40, reinvest: true, protectPct: 0, onShield: 'keep' })
    const engine = new TradingEngine({ exchange, account, settings, learning: scenarioLearningState(T), clock: () => clock.now, sink: (e) => events.push(e), onFailure: rethrowFailure, idPrefix: ID_PREFIX, scorer: tableScorer({}) })
    // Restaurada sin órdenes: la marca en 85 (sin llegar a la liquidación) cruzó el stop y
    // el respaldo cierra a mercado; el último precio tuvo una mecha a 79, más allá de la
    // quiebra (80), así que la salida se acota en 80: pierde el margen entero (40) y la
    // comisión de cierre (0,08) ya no entra en la billetera.
    await engine.restore(stateWith(positionOf('SOLUSDT')))
    await engine.onMarkTick(tick('SOLUSDT', 85, T + MIN, 79))
    const [closed] = ofType(events, 'position_closed')
    // El trade registra lo que de verdad perdió la billetera (40), no el teórico (40,08):
    // estadísticas y aprendizaje ven el mismo número que la cuenta.
    expect(closed?.position).toMatchObject({ closeReason: 'stop', exitPrice: 80, pnlGross: -40, pnlNet: -40, rMultiple: -20 })
    expect((await exchange.getBalance()).total).toBe(0)
    expect(engine.snapshot().accounts.real.saldo).toBe(0)
  })
})

describe('TradingEngine — una falla al cerrar no frena al resto', () => {
  it('un deslistado sin precio en el exchange queda abierto, se avisa la falla y el ciclo sigue', async () => {
    const h = harness({ scorer: tableScorer({ ETHUSDT: 0.6 }) })
    await h.engine.restore(stateWith(positionOf('SOLUSDT')))
    h.clock.now = T + LATENCY
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('ETHUSDT')], { missingSymbols: [], degraded: [], delisted: ['SOLUSDT'] })
    expect(h.failures).toEqual([{ operation: 'close', reason: 'delisted', portfolio: 'real', symbol: 'SOLUSDT', at: T + LATENCY, error: expect.any(Error) }])
    expect(h.engine.snapshot().real.positions.map((s) => s.position.symbol)).toEqual(['SOLUSDT', 'ETHUSDT'])
    expect(opened.map((p) => p.symbol)).toEqual(['ETHUSDT'])
    expect(decisions.map((d) => d.action.kind)).toEqual(['enter'])
    expect(ofType(h.events, 'decisions')).toHaveLength(1)
    // Con precio, el ciclo siguiente lo cierra.
    h.clock.now = T + MIN15 + LATENCY
    const retry = await h.engine.onCandleClose([viewOf('SOLUSDT', { t: T + MIN15 })], { missingSymbols: [], degraded: [], delisted: ['SOLUSDT'] })
    expect(retry.closed.map((c) => [c.symbol, c.closeReason])).toEqual([['SOLUSDT', 'delisted']])
  })

  it('closeAll cierra las que puede y avisa las que no', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(positionOf('SOLUSDT'), positionOf('ETHUSDT')))
    await h.engine.onMarkTick(tick('ETHUSDT', 100, T + MIN))
    h.clock.now = T + 2 * MIN
    const closed = await h.engine.closeAll('close_all')
    expect(closed.map((c) => [c.symbol, c.closeReason])).toEqual([['ETHUSDT', 'close_all']])
    expect(h.failures).toEqual([{ operation: 'close', reason: 'close_all', portfolio: 'real', symbol: 'SOLUSDT', at: T + 2 * MIN, error: expect.any(Error) }])
    expect(h.engine.snapshot().real.positions.map((s) => s.position.symbol)).toEqual(['SOLUSDT'])
  })
})
