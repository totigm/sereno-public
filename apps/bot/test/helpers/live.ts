import type { Composite, Position, Side } from '@sereno/core'
import type { Scorer } from '@sereno/core/src/engine/types'
import { signalRecord } from '@sereno/core/src/learning/state'
import { liquidationPrice } from '@sereno/core/src/risk/liquidation'
import { randomUUID } from 'node:crypto'
import type { BotFlags, CommandRow, EquityPoint, SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS, type CommandInput, type Settings } from '@sereno/shared'
import { klineEvent, markPriceEvent, priceAt, streamNameOf } from '../../src/binance/fake/fixtures'
import type { FakeBinance } from '../../src/binance/fake/server'
import { fakeSocketFactory, type FakeSocket } from '../../src/binance/fake/socket'
import { INTERVAL_MS } from '../../src/binance/types'
import { MarketStream } from '../../src/binance/ws'
import { silentLogger } from '../../src/logger'
import { liveIdPrefix } from '../../src/live/engine-build'
import { NO_FLAGS } from '../../src/live/heartbeat'
import { startLive, type LiveRuntime } from '../../src/live/runtime'
import type { LiveHooks, LiveRest } from '../../src/live/live-types'
import type { RealProcess } from '../../src/real/real-session'
import { restFor } from './binance'
import type { TestDb } from './db'
import { ManualClock, settle } from './manual-clock'

export const M15 = INTERVAL_MS['15m']

// Universo de dos monedas (BTC y ETH con el exchangeInfo falso).
export const TWO_COINS: Settings = { ...DEFAULT_SETTINGS, universe: { ...DEFAULT_SETTINGS.universe, topN: 2 } }

export async function createActiveSession(t: TestDb, settings: Settings = TWO_COINS): Promise<SessionRow> {
  await t.query(`update sessions set status = 'archived', ended_at = now() where status = 'active'`)
  return t.repos.sessions.createLive({ capitalInicial: 1000, settings, learningOrigin: 'zero', name: 'Prueba T20' })
}

export async function dropSession(t: TestDb, id: string): Promise<void> {
  await t.query('delete from sessions where id = $1', [id])
}

// La sesión y su historia de ajustes en el tiempo del reloj falso (la base las sella con
// su propio `now()`): `versions` lleva versión → instante.
export async function backdate(t: TestDb, sessionId: string, startedAt: number, versions: Record<number, number> = {}): Promise<void> {
  await t.query('update sessions set started_at = $2 where id = $1', [sessionId, new Date(startedAt)])
  for (const [version, at] of Object.entries(versions)) {
    await t.query('update settings_history set changed_at = $3 where session_id = $1 and version = $2', [sessionId, Number(version), new Date(at)])
  }
}

// La pausa automática que escribe el bot (la versión nueva).
export async function pauseAuto(t: TestDb, sessionId: string, at: number, reason: string): Promise<number> {
  const row = await t.repos.settings.get(sessionId)
  const result = await t.repos.settings.update(sessionId, { pause: { paused: true, by: 'auto', at: new Date(at).toISOString(), reason } }, row!.version)
  if (!result.ok || result.version === null) throw new Error('no pude pausar la sesión de prueba')
  return result.version
}

// Toti cambia la pausa desde el dashboard (la versión nueva).
export async function setPause(t: TestDb, sessionId: string, pause: Settings['pause']): Promise<number> {
  const row = await t.repos.settings.get(sessionId)
  const result = await t.repos.settings.update(sessionId, { pause }, row!.version, { by: 'toti@example.com' })
  if (!result.ok || result.version === null) throw new Error('no pude cambiar la pausa de la sesión de prueba')
  return result.version
}

// El último latido de un proceso anterior que ya no tiene lease.
export async function previousHeartbeat(t: TestDb, sessionId: string, flags: Partial<BotFlags>, settingsVersionApplied: number): Promise<void> {
  await t.repos.bot.heartbeat({
    sessionId,
    instanceId: 'proceso-anterior',
    phase: 'paused',
    warmProgress: 2,
    universeSize: 2,
    lastCycleAt: null,
    settingsVersionApplied,
    degradedSymbols: [],
    flags: { ...NO_FLAGS, ...flags },
    recentErrors: [],
    botVersion: '0.0.0',
  })
}

export function equityAt(at: number, equity: number): EquityPoint {
  return { at, saldo: equity, equity, margenEnUso: 0, protegido: 0, capitalBase: equity, capitalOperable: equity, shadowEquity: null, kind: 'minute' }
}

export async function enqueueCommand(t: TestDb, sessionId: string, kind: CommandInput['kind'], payload: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const ok = await t.repos.commands.enqueue({ id, sessionId, kind, payload, requestedBy: 'toti@example.com' } as CommandInput)
  if (!ok) throw new Error(`no pude encolar ${kind}`)
  return id
}

export async function commandRow(t: TestDb, sessionId: string, id: string): Promise<CommandRow | undefined> {
  return (await t.repos.commands.listRecent(sessionId)).find((c) => c.id === id)
}

// S′ fijo por símbolo (0 si no figura): el motor decide sin depender de las velas.
export function fixedScorer(table: Record<string, number> = {}): Scorer {
  return (view, weights) => compositeOf(table[view.symbol] ?? 0, weights)
}

function compositeOf(Sprime: number, weights: Composite['weights'] = signalRecord(1)): Composite {
  const sign = Math.sign(Sprime)
  return {
    S: Sprime,
    Sprime,
    confidence: Math.abs(Sprime),
    signals: [{ id: 'trendHigher', value: sign }],
    missing: [],
    weights: { ...weights },
    modifiers: { adx: 1, vol: 1 },
    relVolume: 1,
    higherTrendAgainst: 0,
  }
}

// Una abierta real ya guardada (como la habría dejado un proceso anterior), con su evento `open`.
export async function seedOpen(
  t: TestDb,
  sessionId: string,
  { symbol, side = 'long', entryPrice, stopPrice, qty, openedAt, shadow = false }: { symbol: string; side?: Side; entryPrice: number; stopPrice: number; qty: number; openedAt: number; shadow?: boolean },
): Promise<Position> {
  const leverage = 3
  const notional = qty * entryPrice
  const position: Position = {
    id: `${liveIdPrefix(sessionId)}-${shadow ? 'shadow' : 'real'}-${symbol}-${openedAt}`,
    symbol,
    side,
    leverage,
    margin: notional / leverage,
    notional,
    qty,
    entryPrice,
    openedAt,
    stopPrice,
    takeProfitPrice: side === 'long' ? entryPrice * 1.1 : entryPrice * 0.9,
    liquidationPrice: liquidationPrice(side, entryPrice, leverage, DEFAULT_SETTINGS.risk.mmrBySymbol[symbol] ?? DEFAULT_SETTINGS.risk.mmrDefault),
    distanciaStop: Math.abs(entryPrice - stopPrice) / entryPrice,
    riesgoReal: qty * Math.abs(entryPrice - stopPrice),
    thetaAtOpen: 0.35,
    trailingActive: false,
    bestPrice: entryPrice,
    stopOrderId: null,
    tpOrderId: null,
    feesPaid: notional * 0.0005,
    fundingPaid: 0,
    shadow,
    openReason: `Abrí un ${side} en ${symbol}.`,
    signalsAtOpen: [],
    mode: 'auto',
  }
  await t.repos.positions.upsertOpen(sessionId, position)
  await t.repos.positions.addEvent(position.id, { kind: 'open', payload: { price: entryPrice, qty, fee: position.feesPaid, spreadCost: 0.01, slippageCost: 0.02 }, at: openedAt })
  return position
}

export interface Harness {
  clock: ManualClock
  runtime: LiveRuntime
  sockets: FakeSocket[]
  // Abre el handshake del socket más reciente (el stream recién conectado).
  openSocket(): FakeSocket
  pushKline(symbol: string, openTime: number, interval?: '15m' | '1h' | '4h'): void
  pushMark(symbol: string, markPrice: number): void
}

export interface HarnessOptions {
  t: TestDb
  fake: FakeBinance
  start: number
  scorer?: Scorer
  instanceId?: string
  hooks?: LiveHooks
  // Para interceptar llamadas REST (demorar el calentamiento, por ejemplo).
  wrapRest?: (rest: LiveRest) => LiveRest
  // La sesión con plata real en el mismo proceso, armada con el reloj y el REST de papel.
  real?: (ctx: { clock: ManualClock; rest: LiveRest }) => RealProcess
}

export async function startHarness({ t, fake, start, scorer = fixedScorer(), instanceId, hooks, wrapRest = (r) => r, real }: HarnessOptions): Promise<Harness> {
  const clock = new ManualClock(start)
  const rest = wrapRest(restFor(fake, clock.now).rest)
  const { WebSocket, sockets } = fakeSocketFactory()
  const runtime = await startLive({
    db: t.db,
    rest,
    // La reconexión del stream corre con temporizadores reales: un backoff corto.
    streamFactory: (symbols) => new MarketStream({ symbols, WebSocket, now: clock.now, logger: silentLogger, backoffBaseMs: 1, backoffMaxMs: 5 }),
    clock,
    scorer,
    ...(instanceId ? { instanceId } : {}),
    ...(hooks ? { hooks } : {}),
    ...(real ? { real: real({ clock, rest }) } : {}),
  })
  const socket = (): FakeSocket => {
    const last = sockets.at(-1)
    if (!last) throw new Error('el runtime todavía no abrió el stream')
    return last
  }
  return {
    clock,
    runtime,
    sockets,
    openSocket: () => {
      const s = socket()
      s.open()
      return s
    },
    pushKline: (symbol, openTime, interval = '15m') => {
      const close = priceAt(symbol, openTime + INTERVAL_MS[interval])
      const data = klineEvent({ symbol, interval, openTime, closed: true, open: close, high: close * 1.001, low: close * 0.999, close, eventTime: clock.now() })
      socket().receive({ stream: streamNameOf(symbol, `kline_${interval}`), data })
    },
    pushMark: (symbol, markPrice) => {
      const data = markPriceEvent({ symbol, markPrice, fundingRate: '0.0001', nextFundingTime: Math.ceil((clock.now() + 1) / (8 * 3_600_000)) * 8 * 3_600_000, at: clock.now() })
      socket().receive({ stream: streamNameOf(symbol, 'markPrice@1s'), data })
    },
  }
}

export { settle }
