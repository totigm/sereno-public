import type { Candle, Composite, EngineEvent, MarkTick, MarketView, SymbolInfo } from '@sereno/core'
import { Account } from '@sereno/core/src/capital/account'
import { initialGuardState } from '@sereno/core/src/engine/account-guard'
import { TradingEngine } from '@sereno/core/src/engine/engine'
import { initialLearningState, signalRecord } from '@sereno/core/src/learning/state'
import type { EngineState, Scorer } from '@sereno/core/src/engine/types'
import type { PositionRecord } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { FakeBinance } from '../../src/binance/fake/server'
import { UserDataStream } from '../../src/binance/user-stream'
import { RealAccount } from '../../src/real/account'
import { ClientIds } from '../../src/real/client-id'
import { liveIdPrefix } from '../../src/live/engine-build'
import { positionOf } from '../../src/live/restore-load'
import { BinanceFuturesExchange, type AtStart, type OpeningsGate, type RealNote } from '../../src/real/exchange'
import type { RetryPolicy } from '../../src/real/retry'
import { tradeFor, type TradeKit } from './binance'
import { ManualClock } from './manual-clock'

// Piezas de la sesión real contra el Binance falso: la cuenta (REST + user data stream), los
// ids de cliente y el adaptador, con un reloj manual para los plazos y reintentos.

export const REAL_SESSION = 'ses_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
export const REAL_T0 = Date.UTC(2026, 10, 1, 12)

// Los contratos del falso (`fake/fixtures.ts`), como los ve el motor.
export const REAL_INFOS: Record<string, SymbolInfo> = {
  SOLUSDT: info('SOLUSDT', { stepSize: 1, minQty: 1, tickSize: 0.01, quantityPrecision: 0, mmr: 0.01 }),
  ETHUSDT: info('ETHUSDT', { stepSize: 0.001, minQty: 0.001, tickSize: 0.01, quantityPrecision: 3, mmr: 0.005 }),
  BTCUSDT: info('BTCUSDT', { stepSize: 0.001, minQty: 0.001, tickSize: 0.1, quantityPrecision: 3, mmr: 0.004, minNotional: 50 }),
}

function info(symbol: string, overrides: Partial<SymbolInfo>): SymbolInfo {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    minNotional: 5,
    minQty: 0.001,
    stepSize: 0.001,
    tickSize: 0.01,
    quantityPrecision: 3,
    mmr: 0.01,
    liquidationFee: 0.0125,
    fundingIntervalHours: 8,
    halfSpreadRate: 0,
    underlyingType: 'COIN',
    underlyingSubType: ['Layer-1'],
    onboardDate: 0,
    ...overrides,
  }
}

export interface RealRig {
  clock: ManualClock
  kit: TradeKit
  stream: UserDataStream
  account: RealAccount
  ids: ClientIds
  exchange: BinanceFuturesExchange
  notes: RealNote[]
  gate: { value: OpeningsGate }
}

export interface RigOptions {
  initialBalance?: number
  retry?: RetryPolicy
  clock?: ManualClock
  atStart?: AtStart
}

// Una cuenta conectada al falso (ya sincronizada) y un adaptador sobre ella. El falso pasa a
// usar el reloj manual.
export async function realRig(fake: FakeBinance, options: RigOptions = {}): Promise<RealRig> {
  const clock = options.clock ?? new ManualClock(REAL_T0)
  // Binance vive en el mismo reloj: los tiempos de los trades y los de la sesión se comparan.
  fake.now = clock.now
  const kit = tradeFor(fake)
  const stream = new UserDataStream({ trade: kit.trade, url: fake.userWsUrl, clock, backoffBaseMs: 5, backoffMaxMs: 20 })
  const account = new RealAccount({ trade: kit.trade, stream, sessionId: REAL_SESSION, clock })
  await account.start()
  const ids = new ClientIds(REAL_SESSION, clock.now)
  const notes: RealNote[] = []
  const gate: { value: OpeningsGate } = { value: { allowed: true } }
  const exchange = adapterFor({ clock, kit, account, ids, notes, gate }, options)
  return { clock, kit, stream, account, ids, exchange, notes, gate }
}

// Otro adaptador sobre la misma cuenta (como cuando el motor se rehace o el bot reinicia).
export function adapterFor(rig: Pick<RealRig, 'clock' | 'kit' | 'account' | 'ids' | 'notes' | 'gate'>, options: RigOptions = {}): BinanceFuturesExchange {
  return new BinanceFuturesExchange({
    account: rig.account,
    trade: rig.kit.trade,
    ids: rig.ids,
    infos: REAL_INFOS,
    clock: rig.clock,
    initialBalance: options.initialBalance ?? 1_000,
    openings: () => rig.gate.value,
    onNote: (note) => rig.notes.push(note),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.atStart ? { atStart: options.atStart } : {}),
  })
}

// Hace avanzar el reloj manual (de a `stepMs`) mientras la tarea hace IO de verdad contra el
// falso, hasta que termina.
export async function drive<T>(clock: ManualClock, task: Promise<T>, stepMs = 250): Promise<T> {
  let done = false
  task.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < 400 && !done; i++) {
    await clock.advance(stepMs)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return task
}

// ---------- Para correr el motor sobre el adaptador ----------

const HOUR = 3_600_000
const MIN15 = 15 * 60_000

function candle(openTime: number, span: number, price: number, halfRange: number): Candle {
  return { openTime, closeTime: openTime + span - 1, open: price, high: price + halfRange, low: price - halfRange, close: price, volume: 10, quoteVolume: 10 * price, closed: true }
}

// Una vista con la vela de decisión que cierra en `t` y 20 velas de 1h con rango `2·halfRange`.
export function realView(symbol: string, t: number, price: number, halfRange: number): MarketView {
  const info = REAL_INFOS[symbol]
  if (!info) throw new Error(`sin contrato de prueba para ${symbol}`)
  return {
    t,
    symbol,
    info,
    candles: { '15m': [candle(t - MIN15, MIN15, price, 0)], '1h': Array.from({ length: 20 }, (_, i) => candle(t - (20 - i) * HOUR, HOUR, price, halfRange)), '4h': [] },
    futures: null,
    btc: { candles4h: [], realizedVol24h: null, realizedVol30dMean: null },
    markPrice: price,
    lastPrice: price,
  }
}

// S′ fijo por símbolo, con dos señales a favor (la frase de apertura dice por qué entró).
export function fixedScorer(table: Record<string, number>): Scorer {
  return (view, weights) => {
    const Sprime = table[view.symbol] ?? 0
    const sign = Math.sign(Sprime)
    const composite: Composite = {
      S: Sprime,
      Sprime,
      confidence: Math.abs(Sprime),
      signals: [
        { id: 'trendHigher', value: sign },
        { id: 'funding', value: 0.5 * sign },
      ],
      missing: [],
      weights: { ...signalRecord(1), ...weights },
      modifiers: { adx: 1, vol: 1 },
      relVolume: 1,
      higherTrendAgainst: 0,
    }
    return composite
  }
}

// Un motor sin sombra sobre el adaptador del equipo, con S′ fijo por moneda. Una falla del
// motor rompe el test.
export function realEngine(rig: Pick<RealRig, 'exchange' | 'clock'>, scores: Record<string, number>): { engine: TradingEngine; events: EngineEvent[] } {
  const events: EngineEvent[] = []
  const { reinvest, protectPct, onShield } = DEFAULT_SETTINGS.capital
  const engine = new TradingEngine({
    exchange: rig.exchange,
    settings: DEFAULT_SETTINGS,
    learning: initialLearningState(REAL_T0),
    account: new Account({ capitalInicial: 1_000, reinvest, protectPct, onShield }),
    clock: rig.clock.now,
    sink: (e) => events.push(e),
    onFailure: (f) => {
      throw f.error
    },
    idPrefix: liveIdPrefix(REAL_SESSION),
    scorer: fixedScorer(scores),
  })
  return { engine, events }
}

// Lo que el runtime retoma de la base: las abiertas reales, sin sombra.
export function restoredState(open: readonly PositionRecord[], now: number): EngineState {
  return {
    real: { positions: open.map((record) => ({ position: positionOf(record), entryCosts: { spread: 0, slippage: 0 }, tickSize: REAL_INFOS[record.symbol]!.tickSize })), guard: initialGuardState(now) },
    shadow: null,
    waitedAt: {},
  }
}

export function markTick(symbol: string, price: number, at: number): MarkTick {
  return { symbol, markPrice: price, lastPrice: price, at, fundingRate: null, nextFundingTime: null }
}
