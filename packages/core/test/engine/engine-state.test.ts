import { describe, expect, it } from 'vitest'
import { Account } from '../../src/capital/account'
import { TradingEngine } from '../../src/engine/engine'
import type { EngineSnapshot } from '../../src/engine/types'
import { liquidationPrice } from '../../src/risk/liquidation'
import type { EngineEvent } from '../../src/types'
import {
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
  rethrowFailure,
  settingsWith,
  stateWith,
  SYMBOLS,
  T,
  tableScorer,
  tick,
  viewOf,
} from './fixtures'

// Todas superan el θ 0,55 por defecto con que decide la sombra.
const SCORES = { SOLUSDT: 0.6, ETHUSDT: 0.58, INJUSDT: -0.58 }

// Abre tres, ETH pierde en el stop (queda en enfriamiento) y SOL mueve el stop a la entrada.
async function midSession() {
  const h = harness({ scorer: tableScorer(SCORES), shadow: true })
  await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT'), viewOf('INJUSDT')], NO_CONTEXT)
  await h.engine.onMarkTick(tick('ETHUSDT', 95.9, T + 3 * MIN))
  await h.engine.onMarkTick(tick('SOLUSDT', 103, T + 4 * MIN))
  return h
}

function rebuild(snapshot: EngineSnapshot, events: EngineEvent[]) {
  const settings = settingsWith()
  const clock = { now: T + 5 * MIN }
  const infos = SYMBOLS.map((s) => infoOf(s))
  const real = snapshot.accounts.real
  const shadow = snapshot.accounts.shadow!
  return {
    clock,
    engine: new TradingEngine({
      // El saldo inicial del simulador es el wallet: margen incluido y comisión de apertura ya pagada.
      exchange: exchangeFor(settings, infos, clock, real.saldo),
      account: new Account({ capitalInicial: 1_000, saldo: real.saldo, protegido: real.protegido, baseBlindaje: real.baseBlindaje, reinvest: true, protectPct: 0.7, onShield: 'reduce' }),
      shadow: {
        exchange: exchangeFor(settings, infos, clock, shadow.saldo),
        account: new Account({ capitalInicial: 1_000, saldo: shadow.saldo, protegido: shadow.protegido, baseBlindaje: shadow.baseBlindaje, reinvest: true, protectPct: 0.7, onShield: 'reduce' }),
      },
      settings,
      learning: snapshot.learning,
      clock: () => clock.now,
      sink: (e) => events.push(e),
      onFailure: rethrowFailure,
      idPrefix: ID_PREFIX,
      scorer: tableScorer(SCORES),
    }),
  }
}

describe('TradingEngine — snapshot y restore', () => {
  it('el snapshot es JSON y alcanza para retomar: posiciones, cuentas, reglas de cuenta y aprendizaje de la sombra', async () => {
    const h = await midSession()
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot())) as EngineSnapshot
    expect(snapshot.real.positions.map((s) => s.position.symbol)).toEqual(['SOLUSDT', 'INJUSDT'])
    expect(snapshot.real.guard.cooldownUntil).toEqual({ ETHUSDT: T + 3 * MIN + 4 * MIN15 })
    expect(snapshot.shadow?.learning.tradesBySymbol).toEqual({ ETHUSDT: 1 })

    const events: EngineEvent[] = []
    const b = rebuild(snapshot, events)
    await b.engine.restore(snapshot)
    const restored = b.engine.snapshot()
    const withoutOrders = (s: EngineSnapshot) => s.real.positions.map((p) => ({ ...p, position: { ...p.position, stopOrderId: null, tpOrderId: null } }))
    expect(withoutOrders(restored)).toEqual(withoutOrders(snapshot))
    expect(restored.real.guard).toEqual(snapshot.real.guard)
    expect(restored.shadow).toEqual({ ...snapshot.shadow, positions: expect.any(Array) })
    expect(restored.accounts.real.saldo).toBeCloseTo(snapshot.accounts.real.saldo, 9)
  })

  it('después de restaurar, los ticks y los ciclos siguen como si nada: stop por respaldo y enfriamiento vigente', async () => {
    const h = await midSession()
    const snapshot = JSON.parse(JSON.stringify(h.engine.snapshot())) as EngineSnapshot
    const events: EngineEvent[] = []
    const b = rebuild(snapshot, events)
    await b.engine.restore(snapshot)
    // INJ short en 100 con stop en 103 (real) y en 104 (sombra, k 2): la marca 104,5 cruza los dos.
    await b.engine.onMarkTick(tick('INJUSDT', 104.5, T + 6 * MIN))
    expect(ofType(events, 'position_closed').map((e) => [e.position.symbol, e.position.closeReason, e.position.shadow])).toEqual([
      ['INJUSDT', 'stop', false],
      ['INJUSDT', 'stop', true],
    ])
    b.clock.now = T + MIN15 + LATENCY
    const { decisions } = await b.engine.onCandleClose([viewOf('ETHUSDT', { t: T + MIN15 })], NO_CONTEXT)
    expect(decisions[0]?.action).toEqual({ kind: 'blocked', reason: 'cooldown', wantedSide: 'long' })
  })

  it('los ids de posición llevan el prefijo de la sesión; sin prefijo el motor no arranca', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.6 }), shadow: true })
    const { opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(opened.map((p) => p.id)).toEqual([`sesion-1-real-SOLUSDT-${T + LATENCY}`, `sesion-1-shadow-SOLUSDT-${T + LATENCY}`])
    expect(() => new TradingEngine({ ...h.deps, idPrefix: '' })).toThrow(RangeError)
  })

  it('si el mmr cambió entre reinicios, el registro y el snapshot quedan con la liquidación recalculada', async () => {
    // La guardada salió con mmr 1%; Binance lo subió a 2%.
    const h = harness({ scorer: tableScorer({}), infos: SYMBOLS.map((s) => infoOf(s, s === 'SOLUSDT' ? { mmr: 0.02 } : {})) })
    const before = liquidationPrice('long', 100, 5, 0.01)
    const after = liquidationPrice('long', 100, 5, 0.02)
    const report = await h.engine.restore(stateWith(positionOf('SOLUSDT'), positionOf('ETHUSDT')))
    expect(h.engine.snapshot().real.positions.map((s) => [s.position.symbol, s.position.liquidationPrice])).toEqual([
      ['SOLUSDT', after],
      ['ETHUSDT', before],
    ])
    expect(report.liquidations).toEqual([
      {
        positionId: 'real-SOLUSDT-restored',
        symbol: 'SOLUSDT',
        shadow: false,
        from: before,
        to: after,
        phrase: 'Binance cambió el margen de mantenimiento de SOL: la liquidación del long pasa de 80,81 a 81,63.',
      },
    ])
  })

  it('si la liquidación guardada vale, restore no informa nada', async () => {
    const h = harness({ scorer: tableScorer({}) })
    const report = await h.engine.restore(stateWith(positionOf('SOLUSDT')))
    expect(report.liquidations).toEqual([])
  })

  it('restore sólo vale sobre un motor recién creado', async () => {
    const h = harness({ scorer: tableScorer({}) })
    await h.engine.restore(stateWith(positionOf('SOLUSDT')))
    await expect(h.engine.restore(stateWith(positionOf('ETHUSDT')))).rejects.toThrow()
  })
})

describe('TradingEngine — determinismo', () => {
  async function fullSession(): Promise<EngineEvent[]> {
    const table: Record<string, number> = { ...SCORES, SUIUSDT: 0.2 }
    const settings = settingsWith({ risk: { takerFeeRate: 0.0005, slippageRate: 0.0002 } })
    const h = harness({ settings, scorer: tableScorer(table), shadow: true, infos: SYMBOLS.map((s) => infoOf(s, { halfSpreadRate: 0.0001 })) })
    const views = (t: number) => SYMBOLS.map((s) => viewOf(s, { t }))
    await h.engine.onCandleClose(views(T), { missingSymbols: [], degraded: ['SUIUSDT'] })
    for (const [i, mark] of [101, 102.5, 104, 103.2].entries()) await h.engine.onMarkTick(tick('SOLUSDT', mark, T + (i + 1) * MIN))
    await h.engine.onFunding({ symbol: 'INJUSDT', at: T + 6 * MIN, rate: 0.0003, markPrice: 100 })
    await h.engine.onMarkTick(tick('ETHUSDT', 96.5, T + 7 * MIN))
    table['INJUSDT'] = 0.3
    h.clock.now = T + MIN15 + LATENCY
    await h.engine.onCandleClose(views(T + MIN15), NO_CONTEXT)
    await h.engine.closeAll('close_all')
    expect(h.failures).toEqual([])
    return h.events
  }

  it('las mismas entradas dan exactamente los mismos eventos', async () => {
    const first = await fullSession()
    const second = await fullSession()
    expect(first.length).toBeGreaterThan(10)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(new Set(first.map((e) => e.type))).toEqual(new Set(['decisions', 'position_opened', 'stop_moved', 'funding_applied', 'position_closed', 'learning_updated', 'waited']))
  })
})
