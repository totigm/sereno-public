import { describe, expect, it } from 'vitest'
import { initialGuardState } from '../../src/engine/account-guard'
import { runEntries } from '../../src/engine/entries'
import { LearnedPortfolio } from '../../src/engine/portfolio'
import { PositionManager } from '../../src/engine/position-manager'
import type { ProtectiveOrder } from '../../src/engine/types'
import { OrderRejectedError } from '../../src/exchange/errors'
import type {
  Balance,
  EngineExchange,
  ExchangePosition,
  FundingApplied,
  MarketOrder,
  Order,
  OrderId,
  RestoreResult,
  StopOrder,
  TriggeredOrder,
  Unsubscribe,
} from '../../src/exchange/types'
import type { CloseReason, EntryPlan, Fill } from '../../src/types'
import { accountFor, compositeOf, scenarioLearningState, settingsWith, T, viewOf } from './fixtures'

// Un exchange de mentira que anota cada orden en el orden en que llega. Con
// `protectiveOrders: 'overlapping'` es como Binance con stops por cantidad: admite el
// viejo y el nuevo a la vez.
class ScriptedExchange implements EngineExchange {
  readonly calls: string[] = []
  readonly stops: StopOrder[] = []
  readonly takeProfits: StopOrder[] = []
  failStops = 0
  failTakeProfits = 0
  failCancels = 0
  rejectEntry: OrderRejectedError | null = null
  private ids = 0
  private position: ExchangePosition | null = null

  constructor(readonly protectiveOrders: 'single' | 'overlapping') {}

  async setLeverage(): Promise<void> {}

  async placeMarketOrder(req: MarketOrder): Promise<Fill> {
    if (this.rejectEntry) throw this.rejectEntry
    const side = req.side === 'buy' ? 'long' : 'short'
    this.position = {
      symbol: req.symbol,
      side,
      leverage: 5,
      margin: (req.qty * 100) / 5,
      notional: req.qty * 100,
      qty: req.qty,
      entryPrice: 100,
      openedAt: T,
      liquidationPrice: 80.8,
      feesPaid: 0,
      fundingPaid: 0,
      markPrice: 100,
      unrealized: 0,
    }
    return { symbol: req.symbol, side: req.side, price: 100, qty: req.qty, fee: 0, at: T, spreadCost: 0, slippageCost: 0 }
  }

  async placeStopMarket(req: StopOrder): Promise<OrderId> {
    this.calls.push(`stop ${req.stopPrice}`)
    this.stops.push(req)
    if (this.failStops > 0) {
      this.failStops -= 1
      throw new Error('Binance no contestó')
    }
    return this.nextId('stop')
  }

  async placeTakeProfitMarket(req: StopOrder): Promise<OrderId> {
    this.calls.push(`tp ${req.stopPrice}`)
    this.takeProfits.push(req)
    if (this.failTakeProfits > 0) {
      this.failTakeProfits -= 1
      throw new Error('Binance no contestó')
    }
    return this.nextId('tp')
  }

  async cancelOrder(_symbol: string, orderId: OrderId): Promise<void> {
    this.calls.push(`cancel ${orderId}`)
    if (this.failCancels > 0) {
      this.failCancels -= 1
      throw new Error('Unknown order sent.')
    }
  }

  async closePosition(_symbol: string, _reason: CloseReason): Promise<Fill> {
    throw new Error('no se usa en estos tests')
  }

  async getPositions(): Promise<ExchangePosition[]> {
    return this.position ? [this.position] : []
  }

  async getOpenOrders(): Promise<Order[]> {
    return []
  }

  async getBalance(): Promise<Balance> {
    return { total: 1000, available: 1000, marginInUse: 0, unrealized: 0 }
  }

  onMarkPrice(): Unsubscribe {
    return () => undefined
  }

  onFunding(): Unsubscribe {
    return () => undefined
  }

  processTick(): TriggeredOrder[] {
    return []
  }

  applyFunding(): FundingApplied[] {
    return []
  }

  setPrices(): void {}

  restorePosition(): RestoreResult {
    return { liquidationRecalculated: null }
  }

  private nextId(kind: string): OrderId {
    this.ids += 1
    return `${kind}-${this.ids}`
  }
}

const PLAN: EntryPlan = {
  side: 'long',
  price: 100,
  distanciaStop: 0.03,
  riesgoUsd: 6,
  riesgoReal: 6,
  leverage: 5,
  margin: 40,
  notional: 200,
  qty: 2,
  stopPrice: 97,
  takeProfitPrice: 106,
  liquidationPrice: 80.8,
  multipliers: { confidence: 1, symbol: 1, btc: 1 },
  theta: 0.55,
}

async function openWith(exchange: ScriptedExchange) {
  const failures: ProtectiveOrder[] = []
  const manager = new PositionManager({
    exchange,
    shadow: false,
    idPrefix: 'sesion-real',
    realize: () => undefined,
    onProtectFailed: (_symbol, order) => failures.push(order),
  })
  const outcome = await manager.open({ symbol: 'SOLUSDT', plan: PLAN, composite: compositeOf(0.6), tickSize: 0.01, mode: 'auto' })
  expect(outcome.kind).toBe('opened')
  exchange.calls.length = 0
  return { manager, failures }
}

describe('PositionManager con órdenes de protección superpuestas', () => {
  it('mueve el stop poniendo el nuevo antes de cancelar el viejo', async () => {
    const exchange = new ScriptedExchange('overlapping')
    const { manager } = await openWith(exchange)
    const { position } = await manager.moveStop('SOLUSDT', 100)
    expect(exchange.calls).toEqual(['stop 100', 'cancel stop-1'])
    expect(exchange.stops.at(-1)).toEqual({ symbol: 'SOLUSDT', side: 'sell', stopPrice: 100, qty: 2, reduceOnly: true })
    expect(position).toMatchObject({ stopPrice: 100, stopOrderId: 'stop-3', trailingActive: true })
  })

  it('si el nuevo falla, el viejo sigue y se reintenta', async () => {
    const exchange = new ScriptedExchange('overlapping')
    const { manager, failures } = await openWith(exchange)
    exchange.failStops = 1
    const { position } = await manager.moveStop('SOLUSDT', 100)
    expect(exchange.calls).toEqual(['stop 100'])
    expect(position).toMatchObject({ stopPrice: 100, stopOrderId: null })
    expect(failures).toEqual(['stop'])

    // Otro movimiento mientras tanto: el viejo sigue siendo el único que protege.
    await manager.moveStop('SOLUSDT', 100.5)
    await manager.protect('SOLUSDT')
    expect(exchange.calls).toEqual(['stop 100', 'stop 100.5', 'cancel stop-1'])
    expect(manager.get('SOLUSDT')).toMatchObject({ stopPrice: 100.5, stopOrderId: 'stop-3' })
    // Ya no queda nada viejo por cancelar.
    await manager.protect('SOLUSDT')
    expect(exchange.calls).toHaveLength(3)
  })

  it('si el viejo no se cancela, el stop nuevo queda, se avisa una vez y se reintenta', async () => {
    const exchange = new ScriptedExchange('overlapping')
    const { manager, failures } = await openWith(exchange)
    exchange.failCancels = 2
    const { position } = await manager.moveStop('SOLUSDT', 100)
    expect(exchange.calls).toEqual(['stop 100', 'cancel stop-1'])
    expect(position).toMatchObject({ stopPrice: 100, stopOrderId: 'stop-3', trailingActive: true })
    expect(manager.get('SOLUSDT')).toMatchObject({ stopPrice: 100, stopOrderId: 'stop-3' })
    expect(failures).toEqual(['stale_stop'])

    // El tick siguiente reintenta sin volver a avisar; el otro lo cancela.
    await manager.protect('SOLUSDT')
    expect(failures).toEqual(['stale_stop'])
    await manager.protect('SOLUSDT')
    await manager.protect('SOLUSDT')
    expect(exchange.calls).toEqual(['stop 100', 'cancel stop-1', 'cancel stop-1', 'cancel stop-1'])
  })

  it('un viejo que no se cancela no frena el take profit ni el trailing', async () => {
    const exchange = new ScriptedExchange('overlapping')
    exchange.failTakeProfits = 1
    const { manager, failures } = await openWith(exchange)
    expect(failures).toEqual(['take_profit'])
    exchange.failCancels = 1
    await manager.moveStop('SOLUSDT', 100)
    expect(exchange.calls).toEqual(['stop 100', 'cancel stop-1', 'tp 106'])
    expect(manager.get('SOLUSDT')).toMatchObject({ tpOrderId: 'tp-3' })

    // El trailing sigue: los dos viejos se cancelan con el stop nuevo puesto.
    const { position } = await manager.moveStop('SOLUSDT', 101)
    expect(position).toMatchObject({ stopPrice: 101, stopOrderId: 'stop-4' })
    expect(exchange.calls.slice(3)).toEqual(['stop 101', 'cancel stop-1', 'cancel stop-2'])
    await manager.protect('SOLUSDT')
    expect(exchange.calls).toHaveLength(6)
    expect(failures).toEqual(['take_profit', 'stale_stop'])
  })

  it('una racha nueva de rechazos al cancelar se vuelve a avisar', async () => {
    const exchange = new ScriptedExchange('overlapping')
    const { manager, failures } = await openWith(exchange)
    exchange.failCancels = 1
    await manager.moveStop('SOLUSDT', 100)
    await manager.protect('SOLUSDT')
    exchange.failCancels = 1
    await manager.moveStop('SOLUSDT', 101)
    expect(failures).toEqual(['stale_stop', 'stale_stop'])
  })

  it('stop y take profit van por la cantidad de la posición y sólo reducen', async () => {
    const exchange = new ScriptedExchange('overlapping')
    await openWith(exchange)
    expect(exchange.stops).toEqual([{ symbol: 'SOLUSDT', side: 'sell', stopPrice: 97, qty: 2, reduceOnly: true }])
    expect(exchange.takeProfits).toEqual([{ symbol: 'SOLUSDT', side: 'sell', stopPrice: 106, qty: 2, reduceOnly: true }])
  })

  it('con una sola orden por símbolo cancela el viejo antes de poner el nuevo, como siempre', async () => {
    const exchange = new ScriptedExchange('single')
    const { manager } = await openWith(exchange)
    await manager.moveStop('SOLUSDT', 100)
    expect(exchange.calls).toEqual(['cancel stop-1', 'stop 100'])
  })

  it('un disparo unprotected cierra con ese motivo', async () => {
    const exchange = new ScriptedExchange('overlapping')
    const { manager } = await openWith(exchange)
    const [state] = await exchange.getPositions()
    if (!state) throw new Error('sin posición')
    const fill = { symbol: 'SOLUSDT', side: 'sell' as const, price: 99.5, qty: 2, fee: 0.1, at: T + 1000, spreadCost: 0, slippageCost: 0, reported: true as const }
    const { closed } = manager.settle({
      symbol: 'SOLUSDT',
      reason: 'unprotected',
      orderId: null,
      triggerPrice: 99.5,
      markPrice: 99.5,
      fill,
      position: state,
      pnlGross: -1,
      realized: -1.1,
      shortfall: 0,
      liquidationFeeRate: null,
    })
    expect(closed).toMatchObject({ closeReason: 'unprotected', exitPrice: 99.5, pnlNet: -1.1 })
    expect(manager.has('SOLUSDT')).toBe(false)
  })
})

describe('runEntries con rechazos del exchange real', () => {
  it('un rechazo foreign_position bloquea con ese motivo', async () => {
    const exchange = new ScriptedExchange('overlapping')
    exchange.rejectEntry = new OrderRejectedError('foreign_position', 'SOLUSDT tiene una posición que no es del bot', 'tenés una posición tuya en SOL; no la toco')
    const settings = settingsWith()
    const portfolio = new LearnedPortfolio(
      { exchange, account: accountFor(settings, 1_000), guard: initialGuardState(T), idPrefix: 'sesion-real', onProtectFailed: () => undefined },
      scenarioLearningState(T),
    )
    const outcomes = await runEntries({
      portfolio,
      settings: portfolio.settings(settings),
      candidates: [{ view: viewOf('SOLUSDT'), composite: compositeOf(0.6) }],
      paused: false,
      gate: null,
      missing: new Set(),
      degraded: new Set(),
      now: T,
      marks: { SOLUSDT: 100 },
      onOpened: () => {
        throw new Error('no tenía que abrir')
      },
      onFailed: (_symbol, error) => {
        throw error
      },
    })
    expect(outcomes.get('SOLUSDT')).toEqual({ action: { kind: 'blocked', reason: 'foreign_position', wantedSide: 'long' }, journal: true })
  })
})
