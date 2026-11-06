import type { SessionRow } from '@sereno/db'
import type { BinanceEnv } from '@sereno/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { fakeSocketFactory } from '../../src/binance/fake/socket'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceRest } from '../../src/binance/rest'
import { UserDataStream } from '../../src/binance/user-stream'
import { MarketStream } from '../../src/binance/ws'
import { BINANCE_LIMITS, type BotConfig } from '../../src/config'
import { silentLogger } from '../../src/logger'
import type { LiveRest } from '../../src/live/live-types'
import { realTradeRest } from '../../src/real/process'
import type { RealProcess } from '../../src/real/real-session'
import { realUniverse } from '../../src/real/universe'
import { tradeFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, M15, startHarness, TWO_COINS, type Harness } from '../helpers/live'
import type { ManualClock } from '../helpers/manual-clock'

// 12:15 UTC: un borde de 15m que no cierra velas de 1h ni de 4h; el bot arranca 20 s antes.
const T = Date.UTC(2026, 9, 31, 12, 15, 0)
const START = T - 20_000
const WAIT = { timeout: 8_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let paper: SessionRow
let real: SessionRow
let h: Harness | null = null

function configFor(env: BinanceEnv): BotConfig['real'] {
  return { enabled: true, env, apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET, restUrl: fake.baseUrl, sapiUrl: fake.baseUrl, marketWsUrl: fake.wsUrl, userWsUrl: fake.userWsUrl }
}

// La sesión real en mainnet contra el mismo falso que la de papel.
function mainnet({ clock, rest }: { clock: ManualClock; rest: LiveRest }): RealProcess {
  return {
    config: configFor('mainnet'),
    trade: tradeFor(fake).trade,
    userStream: (trade) => new UserDataStream({ trade, url: fake.userWsUrl, clock, backoffBaseMs: 5, backoffMaxMs: 20 }),
    refreshUniverse: realUniverse({ mainnet: { rest, repos: t.repos, logger: silentLogger }, testnet: null }),
    retry: { delaysMs: [0], fillTimeoutMs: 500 },
  }
}

// Un testnet que contesta 500 a todo.
const broken: typeof fetch = async () => new Response(JSON.stringify({ code: -1000, msg: 'An unknown error occured while processing the request.' }), { status: 500 })

function brokenTestnet({ clock, rest }: { clock: ManualClock; rest: LiveRest }): RealProcess {
  const testnetRest = new BinanceRest({ baseUrl: fake.baseUrl, limiter: new RateLimiter(BINANCE_LIMITS), fetch: broken, maxRetries: 0 })
  const { WebSocket } = fakeSocketFactory()
  return {
    config: configFor('testnet'),
    trade: tradeFor(fake, { sapi: false, fetch: broken }).trade,
    userStream: (trade) => new UserDataStream({ trade, url: fake.userWsUrl, clock, backoffBaseMs: 5, backoffMaxMs: 20 }),
    market: { rest: testnetRest, streamFactory: (symbols) => new MarketStream({ symbols, WebSocket, now: clock.now, logger: silentLogger }) },
    refreshUniverse: realUniverse({ mainnet: { rest, repos: t.repos, logger: silentLogger }, testnet: testnetRest }),
  }
}

async function createReal(env: BinanceEnv): Promise<SessionRow> {
  await t.query(`update sessions set status = 'archived', ended_at = now() where status = 'active' and kind = 'live'`)
  const row = await t.repos.sessions.createReal({ capitalInicial: 1_000, lossCap: 0.5, binanceEnv: env })
  // Las mismas dos monedas que la de papel: el calentamiento no espera presupuesto de REST.
  const result = await t.repos.settings.update(row.id, { universe: TWO_COINS.universe }, 1)
  if (!result.ok) throw new Error('no pude ajustar la sesión real de prueba')
  return row
}

async function leases(): Promise<{ session_id: string; instance_id: string }[]> {
  const { rows } = await t.db.$client.query('select session_id, instance_id from bot_lease where session_id = any($1) order by session_id', [[paper.id, real.id]])
  return rows as { session_id: string; instance_id: string }[]
}

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  await fake.stop()
  await t.close()
})

beforeEach(async () => {
  fake.reset()
  paper = await createActiveSession(t)
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  await t.query('delete from sessions where id = any($1)', [[paper.id, real.id]])
})

describe('dos sesiones en un proceso', { timeout: 30_000 }, () => {
  it('papel y real corren en el mismo proceso con leases separados', async () => {
    real = await createReal('mainnet')
    h = await startHarness({ t, fake, start: START, real: mainnet, instanceId: 'proceso-unico' })
    await h.runtime.ready()
    expect(h.runtime.status()).toEqual({ phase: 'live', sessionId: paper.id })
    expect(h.runtime.status('real')).toEqual({ phase: 'live', sessionId: real.id })
    expect((await leases()).map((l) => l.instance_id)).toEqual(['proceso-unico', 'proceso-unico'])
    expect((await leases()).map((l) => l.session_id).sort()).toEqual([paper.id, real.id].sort())

    await h.clock.advance(10_000)
    await vi.waitFor(async () => expect((await t.repos.bot.get(real.id))?.real).toMatchObject({ mode: expect.any(String) }), WAIT)
    expect((await t.repos.bot.get(paper.id))?.real).toBeNull()
  })

  it('un testnet que contesta 500 siempre no frena la de papel', async () => {
    real = await createReal('testnet')
    h = await startHarness({ t, fake, start: START, real: brokenTestnet })
    // Sin `ready()`: la real espera a Binance, y eso es justo lo que la de papel no espera.
    await vi.waitFor(() => expect(h?.runtime.status().phase).toBe('live'), WAIT)
    h.openSocket()
    expect(h.runtime.status()).toEqual({ phase: 'live', sessionId: paper.id })

    await h.clock.advanceTo(T)
    h.pushKline('BTCUSDT', T - M15)
    h.pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => {
      const rows = await t.repos.decisions.range(paper.id, T, T + 1)
      expect(rows.map((r) => r.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
    }, WAIT)
    // La real quedó sin arrancar y lo dice en su latido; la de papel no se enteró.
    expect(h.runtime.status('real').phase).not.toBe('live')
    expect((await t.repos.bot.get(paper.id))?.recentErrors).toEqual([])
  })

  it('en mainnet comparten un solo stream de mercado', async () => {
    real = await createReal('mainnet')
    h = await startHarness({ t, fake, start: START, real: mainnet })
    await h.runtime.ready()
    expect(h.runtime.status('real').phase).toBe('live')
    expect(h.sockets).toHaveLength(1)
    const socket = h.openSocket()
    expect(socket.streams.some((s) => s.startsWith('ethusdt@'))).toBe(true)
  })

  it('las órdenes de la real pasan antes que el calentamiento de papel', async () => {
    real = await createReal('mainnet')
    // El limitador de papel, como lo arma `pnpm bot`, y el cliente de órdenes de mainnet sobre
    // él. Su reloj es del test: el castigo dura hasta que el test lo levanta.
    let limiterNow = Date.now()
    const limiter = new RateLimiter({ ...BINANCE_LIMITS, now: () => limiterNow })
    const rest = new BinanceRest({ baseUrl: fake.baseUrl, limiter, maxRetries: 0 })
    const trade = realTradeRest(configFor('mainnet'), limiter, silentLogger)
    if (!trade) throw new Error('sin cliente de órdenes')
    fake.trading.setMark('ETHUSDT', 2_000)
    // El cliente ya habló con Binance (la hora del servidor queda medida), como en marcha.
    await trade.dualSide()
    // Binance castigó la IP: todo espera en la fila del limitador, también la orden (es el
    // mismo límite de IP).
    limiter.holdUntil(limiterNow + 200)
    const warmup = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol) => rest.klines(symbol, '15m', { limit: 500 }))
    const order = trade.marketOrder({ symbol: 'ETHUSDT', side: 'BUY', quantity: '0.01', reduceOnly: false, clientOrderId: 'sereno-orden-primero' })
    await vi.waitFor(() => expect(limiter.pending).toBe(4), WAIT)
    limiterNow += 200
    await Promise.all([...warmup, order])
    const paths = fake.requests.map((r) => r.path).filter((p) => p === '/fapi/v1/klines' || p === '/fapi/v1/order')
    expect(paths[0]).toBe('/fapi/v1/order')
    expect(paths.filter((p) => p === '/fapi/v1/klines')).toHaveLength(3)
  })
})
