import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { Account } from '../../src/capital/account'
import { initialGuardState } from '../../src/engine/account-guard'
import { TradingEngine } from '../../src/engine/engine'
import type { EngineDeps, EngineFailure, EngineState, Scorer } from '../../src/engine/types'
import { PaperExchange } from '../../src/exchange/paper-exchange'
import { initialLearningState, signalRecord } from '../../src/learning/state'
import { liquidationPrice } from '../../src/risk/liquidation'
import type { Candle, Composite, EngineEvent, LearningState, MarkTick, MarketView, Position, SignalId, SymbolInfo } from '../../src/types'

export const MIN = 60_000
export const MIN15 = 15 * MIN
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
// Cierre de la vela de 15m de las 10:15 en Buenos Aires (13:15 UTC) del 31/10/2026.
export const T = Date.UTC(2026, 9, 31, 13, 15)
// El motor decide 2 s después del cierre.
export const LATENCY = 2_000

export const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'INJUSDT', 'SUIUSDT'] as const

// Contrato sin spread: con taker y slippage en 0 los fills quedan exactamente en el último precio.
export function infoOf(symbol: string, overrides: Partial<SymbolInfo> = {}): SymbolInfo {
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

export interface SettingsPatch {
  mode?: Settings['mode']
  capital?: Partial<Settings['capital']>
  risk?: Partial<Settings['risk']>
  entry?: Partial<Settings['entry']>
  exits?: Partial<Settings['exits']>
  custom?: Partial<Settings['custom']>
  learning?: Partial<Settings['learning']>
  pause?: Partial<Settings['pause']>
}

// Los escenarios se escribieron con θ 0,35 y k 1,5 (los defaults de entonces); quedan fijos
// acá para que un cambio de default no les mueva los números.
export const SCENARIO_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  entry: { ...DEFAULT_SETTINGS.entry, theta: 0.35 },
  exits: { ...DEFAULT_SETTINGS.exits, k: 1.5 },
}

// Lo aprendido al arrancar, con los θ y k con que se escribieron los escenarios (no los de hoy).
export function scenarioLearningState(now: number): LearningState {
  const state = initialLearningState(now)
  return { ...state, params: { ...state.params, theta: SCENARIO_SETTINGS.entry.theta, k: SCENARIO_SETTINGS.exits.k } }
}

// Ajustes de escenario sin comisión ni slippage, para que los números del brief se lean tal cual.
export function settingsWith(patch: SettingsPatch = {}): Settings {
  const d = SCENARIO_SETTINGS
  return {
    ...d,
    mode: patch.mode ?? d.mode,
    capital: { ...d.capital, ...patch.capital },
    risk: { ...d.risk, takerFeeRate: 0, slippageRate: 0, ...patch.risk },
    entry: { ...d.entry, ...patch.entry },
    exits: { ...d.exits, ...patch.exits },
    custom: { ...d.custom, ...patch.custom },
    learning: { ...d.learning, ...patch.learning },
    pause: { ...d.pause, ...patch.pause },
  }
}

function candle(openTime: number, span: number, price: number, halfRange: number): Candle {
  return {
    openTime,
    closeTime: openTime + span - 1,
    open: price,
    high: price + halfRange,
    low: price - halfRange,
    close: price,
    volume: 10,
    quoteVolume: 10 * price,
    closed: true,
  }
}

export interface ViewOptions {
  t?: number
  price?: number
  // ATR(14) de 1h: con k = 1,5 y precio 100, un ATR de 2 da una distancia de stop del 3%.
  atr?: number
  info?: SymbolInfo
  // Sin la vela de 15m que cierra en t (llegó tarde o no llegó).
  withoutDecisionCandle?: boolean
}

export function viewOf(symbol: string, options: ViewOptions = {}): MarketView {
  const t = options.t ?? T
  const price = options.price ?? 100
  const atr = options.atr ?? 2
  const decision = candle(t - MIN15, MIN15, price, 0)
  const hourly = Array.from({ length: 20 }, (_, i) => candle(t - (20 - i) * HOUR, HOUR, price, atr / 2))
  return {
    t,
    symbol,
    info: options.info ?? infoOf(symbol),
    candles: { '15m': options.withoutDecisionCandle ? [] : [decision], '1h': hourly, '4h': [] },
    futures: null,
    btc: { candles4h: [], realizedVol24h: null, realizedVol30dMean: null },
    markPrice: price,
    lastPrice: price,
  }
}

export function compositeOf(Sprime: number, overrides: Partial<Composite> = {}): Composite {
  const sign = Math.sign(Sprime)
  return {
    S: Sprime,
    Sprime,
    confidence: Math.abs(Sprime),
    // Dos señales a favor del lado de S′: la frase de apertura dice por qué entró.
    signals: [
      { id: 'trendHigher', value: sign },
      { id: 'funding', value: 0.5 * sign },
    ],
    missing: [],
    weights: signalRecord(1),
    modifiers: { adx: 1, vol: 1 },
    relVolume: 1,
    higherTrendAgainst: 0,
    ...overrides,
  }
}

// S′ fijo por símbolo (modificable entre ciclos). Los símbolos sin entrada valen 0.
export function tableScorer(table: Record<string, number | Composite>): Scorer {
  return (view, weights) => {
    const entry = table[view.symbol] ?? 0
    const composite = typeof entry === 'number' ? compositeOf(entry) : entry
    return { ...composite, weights: { ...weights } }
  }
}

// S = Σ wᵢ·sᵢ / Σ wᵢ sobre las señales dadas por símbolo, sin modificadores: hace
// visible qué pesos usó cada cartera.
export function weightedScorer(values: Record<string, Partial<Record<SignalId, number>>>): Scorer {
  return (view, weights) => {
    const entries = Object.entries(values[view.symbol] ?? {}) as [SignalId, number][]
    const denominator = entries.reduce((acc, [id]) => acc + weights[id], 0)
    const S = denominator > 0 ? entries.reduce((acc, [id, v]) => acc + weights[id] * v, 0) / denominator : 0
    return compositeOf(S, { signals: entries.map(([id, value]) => ({ id, value })), weights: { ...weights } })
  }
}

export interface HarnessOptions {
  settings?: Settings
  learning?: LearningState
  scorer: Scorer
  shadow?: boolean
  capital?: number
  // Saldo de arranque de lo real (cuenta y billetera); por defecto, el capital.
  saldo?: number
  infos?: SymbolInfo[]
  // La sesión opera plata de verdad (`EngineDeps.realMoney`).
  realMoney?: boolean
}

export interface Harness {
  engine: TradingEngine
  events: EngineEvent[]
  // Lo que el motor salteó y avisó por `onFailure`.
  failures: EngineFailure[]
  exchange: PaperExchange
  account: Account
  shadowExchange: PaperExchange | null
  shadowAccount: Account | null
  clock: { now: number }
  deps: EngineDeps
}

// Prefijo de ids de los tests: los ids de posición quedan `sesion-1-real-…` / `sesion-1-shadow-…`.
export const ID_PREFIX = 'sesion-1'

// Para motores armados a mano en tests que no esperan fallas: una falla rompe el test.
export function rethrowFailure(failure: EngineFailure): never {
  throw failure.error
}

export function accountFor(settings: Settings, capital: number, saldo?: number): Account {
  const { reinvest, protectPct, onShield } = settings.capital
  return new Account({ capitalInicial: capital, reinvest, protectPct, onShield, ...(saldo === undefined ? {} : { saldo }) })
}

export function exchangeFor(settings: Settings, infos: SymbolInfo[], clock: { now: number }, initialBalance: number): PaperExchange {
  return new PaperExchange({
    settings: settings.risk,
    infos: Object.fromEntries(infos.map((i) => [i.symbol, i])),
    clock: () => clock.now,
    initialBalance,
  })
}

export function harness(options: HarnessOptions): Harness {
  const settings = options.settings ?? settingsWith()
  const capital = options.capital ?? 1_000
  const infos = options.infos ?? SYMBOLS.map((s) => infoOf(s))
  const clock = { now: T + LATENCY }
  const events: EngineEvent[] = []
  const failures: EngineFailure[] = []
  const exchange = exchangeFor(settings, infos, clock, options.saldo ?? capital)
  const account = accountFor(settings, capital, options.saldo)
  const shadowExchange = options.shadow ? exchangeFor(settings, infos, clock, capital) : null
  const shadowAccount = options.shadow ? accountFor(settings, capital) : null
  const deps: EngineDeps = {
    exchange,
    settings,
    learning: options.learning ?? scenarioLearningState(T),
    account,
    clock: () => clock.now,
    sink: (e) => events.push(e),
    onFailure: (f) => failures.push(f),
    idPrefix: ID_PREFIX,
    scorer: options.scorer,
    ...(options.realMoney ? { realMoney: true } : {}),
    ...(shadowExchange && shadowAccount ? { shadow: { exchange: shadowExchange, account: shadowAccount } } : {}),
  }
  return { engine: new TradingEngine(deps), events, failures, exchange, account, shadowExchange, shadowAccount, clock, deps }
}

export const NO_CONTEXT = { missingSymbols: [], degraded: [] }

export function tick(symbol: string, mark: number, at: number, last = mark): MarkTick {
  return { symbol, markPrice: mark, lastPrice: last, at, fundingRate: null, nextFundingTime: null }
}

export function ofType<K extends EngineEvent['type']>(events: EngineEvent[], type: K): Extract<EngineEvent, { type: K }>[] {
  return events.filter((e): e is Extract<EngineEvent, { type: K }> => e.type === type)
}

// Una abierta para restaurar: long en 100 con 2 de cantidad a 5x, d 1% (1R = 1 de precio),
// stop 99 y take profit 105, abierta una hora antes de T.
export function positionOf(symbol: string, overrides: Partial<Position> = {}): Position {
  return {
    id: `real-${symbol}-restored`,
    symbol,
    side: 'long',
    leverage: 5,
    margin: 40,
    notional: 200,
    qty: 2,
    entryPrice: 100,
    openedAt: T - HOUR,
    stopPrice: 99,
    takeProfitPrice: 105,
    liquidationPrice: liquidationPrice('long', 100, 5, 0.01),
    distanciaStop: 0.01,
    riesgoReal: 2,
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: 100,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: 0,
    fundingPaid: 0,
    shadow: false,
    openReason: `Abrí un long 5x en ${symbol.replace(/USDT$/, '')} con US$ 40.`,
    signalsAtOpen: [],
    mode: 'auto',
    ...overrides,
  }
}

export function stateWith(...positions: Position[]): EngineState {
  return {
    real: { positions: positions.map((position) => ({ position, entryCosts: { spread: 0, slippage: 0 }, tickSize: 0.01 })), guard: initialGuardState(T) },
    shadow: null,
    waitedAt: {},
  }
}
