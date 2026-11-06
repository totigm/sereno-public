import type { Scorer } from '@sereno/core/src/engine/types'
import type { SessionRow } from '@sereno/db'
import type { BinanceEnv } from '@sereno/shared'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { klineEvent, markPriceEvent, priceAt, streamNameOf } from '../../src/binance/fake/fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { fakeSocketFactory, type FakeSocket } from '../../src/binance/fake/socket'
import { INTERVAL_MS } from '../../src/binance/types'
import { UserDataStream } from '../../src/binance/user-stream'
import { MarketStream } from '../../src/binance/ws'
import type { BotConfig } from '../../src/config'
import { silentLogger } from '../../src/logger'
import { startLive, type LiveRuntime } from '../../src/live/runtime'
import type { RealProcess } from '../../src/real/real-session'
import { realUniverse } from '../../src/real/universe'
import { restFor, tradeFor } from './binance'
import { openTestDb, type TestDb } from './db'
import { createActiveSession, TWO_COINS } from './live'
import { ManualClock } from './manual-clock'

// El proceso entero (`startLive` con los dos slots) contra dos Binance falsos: el de mainnet
// (mercado de la de papel y, con `env 'mainnet'`, la cuenta de la real) y uno de testnet (sin
// `/sapi`), que con `env 'testnet'` tiene su propio mercado y la cuenta de la real. Los streams
// de mercado son sockets falsos que el test alimenta; el user data stream es el del falso, por
// websocket de verdad. Todo corre con un reloj manual que el reinicio conserva.

export interface RealWorld {
  fakeMain: FakeBinance
  fakeTest: FakeBinance
  t: TestDb
}

export async function openRealWorld(): Promise<RealWorld> {
  const [fakeMain, fakeTest, t] = await Promise.all([FakeBinance.start(), FakeBinance.start(), openTestDb()])
  return { fakeMain, fakeTest, t }
}

export async function closeRealWorld({ fakeMain, fakeTest, t }: RealWorld): Promise<void> {
  await Promise.all([fakeMain.stop(), fakeTest.stop()])
  await t.close()
}

// El falso cuenta el peso usado por minuto de la máquina, y con el reloj manual pasan muchos
// minutos del bot en un segundo: el header queda en cero y manda la cuenta de cada limitador,
// que va con el reloj manual.
export function resetRealWorld({ fakeMain, fakeTest }: RealWorld): void {
  for (const fake of [fakeMain, fakeTest]) {
    fake.reset()
    fake.setUsedWeight(0)
  }
  fakeTest.sapiEnabled = false
}

export interface E2eSessions {
  paper: SessionRow
  real: SessionRow
}

// La simulación de dos monedas y una sesión real prendida con el mismo universo (así el
// calentamiento de la real no espera presupuesto de REST).
export async function createSessions(t: TestDb, { realEnv, lossCap = 0.5 }: { realEnv: BinanceEnv; lossCap?: number }): Promise<E2eSessions> {
  const paper = await createActiveSession(t)
  const real = await createRealOnly(t, { realEnv, lossCap })
  return { paper, real }
}

// Archiva la real activa (si hay) y crea otra prendida.
export async function createRealOnly(t: TestDb, { realEnv, lossCap = 0.5, capital = 1_000 }: { realEnv: BinanceEnv; lossCap?: number; capital?: number }): Promise<SessionRow> {
  await t.query(`update sessions set status = 'archived', ended_at = now() where status = 'active' and kind = 'live'`)
  const real = await t.repos.sessions.createReal({ capitalInicial: capital, lossCap, binanceEnv: realEnv })
  const updated = await t.repos.settings.update(real.id, { universe: TWO_COINS.universe }, 1)
  if (!updated.ok) throw new Error('no pude ajustar el universo de la sesión real de prueba')
  return real
}

export interface RealLiveOptions {
  // El `BINANCE_ENV` del proceso.
  env: BinanceEnv
  // `SERENO_REAL_TRADING=on`.
  enabled: boolean
  // Las claves de operación.
  keys: boolean
  scorer: Scorer
  // Sin slot real: el proceso como era antes de la plata real.
  paperOnly?: boolean
  start?: number
  // El del proceso anterior, para un reinicio.
  clock?: ManualClock
  // El backoff del user data stream (ms del reloj manual).
  userBackoffMs?: { base: number; max: number }
}

export interface RealLive {
  runtime: LiveRuntime
  fakeMain: FakeBinance
  fakeTest: FakeBinance
  // El falso cuya cuenta opera la real.
  fakeReal: FakeBinance
  clock: ManualClock
  t: TestDb
  // Completa el handshake de cada stream de mercado que lo esté esperando.
  openStreams(): void
  // La vela cerrada a todos los streams (con el precio del fixture al cierre).
  pushKline(symbol: string, openTime: number, interval?: '15m' | '1h' | '4h'): void
  // La marca en Binance (dispara lo que cruce) y después en todos los streams.
  pushMark(symbol: string, price: number): void
  // La marca sólo en la cuenta de Binance: el stream todavía no la trajo.
  moveBinance(symbol: string, price: number): void
  // Para el proceso y arranca otro con el mismo reloj, la misma base y los mismos falsos; con
  // `at`, el bot estuvo apagado hasta ese momento.
  restart(patch?: Partial<Pick<RealLiveOptions, 'env' | 'enabled' | 'keys' | 'userBackoffMs'>> & { at?: number }): Promise<RealLive>
}

export async function startRealLive(world: RealWorld, options: RealLiveOptions): Promise<RealLive> {
  const { fakeMain, fakeTest, t } = world
  const { env, enabled, keys, scorer } = options
  const clock = options.clock ?? new ManualClock(options.start ?? Date.now())
  const fakeReal = env === 'testnet' ? fakeTest : fakeMain
  // Los dos Binance viven en el reloj del test: velas, trades y la sesión se comparan.
  const paper = restFor(fakeMain, clock.now)
  fakeTest.now = clock.now
  const paperSockets = fakeSocketFactory()
  const realSockets = fakeSocketFactory()
  const streamFactory = (WebSocket: ReturnType<typeof fakeSocketFactory>['WebSocket']) => (symbols: string[]) =>
    new MarketStream({ symbols, WebSocket, now: clock.now, logger: silentLogger, backoffBaseMs: 1, backoffMaxMs: 5 })
  const runtime = await startLive({
    db: t.db,
    rest: paper.rest,
    streamFactory: streamFactory(paperSockets.WebSocket),
    clock,
    scorer,
    ...(options.paperOnly ? {} : { real: realProcess(world, options, clock, paper, streamFactory(realSockets.WebSocket)) }),
  })
  const sockets = (): FakeSocket[] => [paperSockets.sockets.at(-1), realSockets.sockets.at(-1)].filter((s): s is FakeSocket => s !== undefined && s.readyState === 1)
  const live: RealLive = {
    runtime,
    fakeMain,
    fakeTest,
    fakeReal,
    clock,
    t,
    openStreams: () => {
      for (const s of [paperSockets.sockets.at(-1), realSockets.sockets.at(-1)]) if (s?.readyState === 0) s.open()
    },
    pushKline: (symbol, openTime, interval = '15m') => {
      const close = priceAt(symbol, openTime + INTERVAL_MS[interval])
      const data = klineEvent({ symbol, interval, openTime, closed: true, open: close, high: close * 1.001, low: close * 0.999, close, eventTime: clock.now() })
      for (const s of sockets()) s.receive({ stream: streamNameOf(symbol, `kline_${interval}`), data })
    },
    pushMark: (symbol, price) => {
      fakeReal.trading.setMark(symbol, price)
      const data = markPriceEvent({ symbol, markPrice: price, fundingRate: '0.0001', nextFundingTime: Math.ceil((clock.now() + 1) / (8 * 3_600_000)) * 8 * 3_600_000, at: clock.now() })
      for (const s of sockets()) s.receive({ stream: streamNameOf(symbol, 'markPrice@1s'), data })
    },
    moveBinance: (symbol, price) => fakeReal.trading.setMark(symbol, price),
    restart: async ({ at, ...patch } = {}) => {
      await runtime.stop()
      if (at !== undefined) await clock.advanceTo(at)
      return startRealLive(world, { ...options, ...patch, clock })
    },
  }
  return live
}

// Lo que `realProcess` arma en `main.ts`, con el reloj del test: en mainnet la real usa el
// mercado de la de papel y sus órdenes compiten con él por el mismo limitador (el límite de IP
// de Binance); en testnet, el suyo (REST, stream y limitador propios) y su cuenta sin `/sapi`.
function realProcess(
  { fakeMain, fakeTest, t }: RealWorld,
  { env, enabled, keys, userBackoffMs = { base: 5, max: 20 } }: RealLiveOptions,
  clock: ManualClock,
  paper: ReturnType<typeof restFor>,
  streamFactory: (symbols: string[]) => MarketStream,
): RealProcess {
  const testnet = env === 'testnet'
  const fake = testnet ? fakeTest : fakeMain
  const config: BotConfig['real'] = {
    enabled,
    env,
    apiKey: keys ? FAKE_API_KEY : null,
    apiSecret: keys ? FAKE_API_SECRET : null,
    restUrl: fake.baseUrl,
    sapiUrl: testnet ? null : fake.baseUrl,
    marketWsUrl: fake.wsUrl,
    userWsUrl: fake.userWsUrl,
  }
  const market = testnet ? restFor(fakeTest, clock.now) : paper
  const testnetRest = testnet ? market.rest : null
  return {
    config,
    trade: keys ? tradeFor(fake, { sapi: !testnet, now: clock.now, limiter: market.limiter }).trade : null,
    userStream: (trade) => new UserDataStream({ trade, url: fake.userWsUrl, clock, backoffBaseMs: userBackoffMs.base, backoffMaxMs: userBackoffMs.max }),
    ...(testnetRest ? { market: { rest: testnetRest, streamFactory } } : {}),
    refreshUniverse: realUniverse({ mainnet: { rest: paper.rest, repos: t.repos, logger: silentLogger }, testnet: testnetRest }),
    retry: { delaysMs: [0], fillTimeoutMs: 500 },
  }
}
