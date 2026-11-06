import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { FakeBinance } from '../../src/binance/fake/server'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, dropSession, M15, seedOpen, startHarness, type Harness } from '../helpers/live'

// 12:15 UTC: un borde de 15m que no cierra velas de 1h ni de 4h; el bot arranca 20 s antes.
const T = Date.UTC(2026, 9, 31, 12, 15, 0)
const START = T - 20_000
const WAIT = { timeout: 5_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let session: SessionRow
let h: Harness | null = null

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
  session = await createActiveSession(t)
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  await dropSession(t, session.id)
})

async function decisionsAt(at: number) {
  const rows = await t.repos.decisions.range(session.id, at, at + 1)
  return Object.fromEntries(rows.map((r) => [r.symbol, r.action]))
}

async function start(at = START): Promise<Harness> {
  h = await startHarness({ t, fake, start: at })
  await h.runtime.ready()
  h.openSocket()
  return h
}

describe('runtime en vivo', { timeout: 30_000 }, () => {
  it('un cierre de 15m con las dos velas presentes deja dos filas en decisions', async () => {
    const { clock, pushKline } = await start()
    expect(h?.runtime.status()).toEqual({ phase: 'live', sessionId: session.id })
    await clock.advanceTo(T)
    pushKline('BTCUSDT', T - M15)
    pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => expect(await decisionsAt(T)).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'wait' }), WAIT)
  })

  it('si a los 3 s falta una vela, la decisión de esa moneda es no_candle', async () => {
    const { clock, pushKline } = await start()
    await clock.advanceTo(T)
    pushKline('BTCUSDT', T - M15)
    await clock.advance(2_900)
    expect(await decisionsAt(T)).toEqual({})
    await clock.advance(100)
    await vi.waitFor(async () => expect(await decisionsAt(T)).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'blocked:no_candle' }), WAIT)
  })

  it('en un borde de 4 h espera también las velas de 1h y 4h que cierran ahí', async () => {
    const H = Date.UTC(2026, 9, 31, 12, 0, 0)
    const { clock, pushKline } = await start(H - 20_000)
    await clock.advanceTo(H)
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) pushKline(symbol, H - M15)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await decisionsAt(H)).toEqual({})
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      pushKline(symbol, H - 4 * M15, '1h')
      pushKline(symbol, H - 16 * M15, '4h')
    }
    await vi.waitFor(async () => expect(await decisionsAt(H)).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'wait' }), WAIT)
  })

  it('con la sesión pausada el ciclo bloquea entradas, pero un tick que cruza el stop cierra', async () => {
    const eth = await seedOpen(t, session.id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_450, qty: 0.1, openedAt: START - 3_600_000 })
    const { clock, pushKline, pushMark } = await start()
    const row = await t.repos.settings.get(session.id)
    const pause = { paused: true, by: 'user' as const, at: new Date(START).toISOString(), reason: null }
    expect((await t.repos.settings.update(session.id, { pause }, row!.version)).ok).toBe(true)
    await clock.advance(3_000)
    await vi.waitFor(() => expect(h?.runtime.status().phase).toBe('paused'), WAIT)

    await clock.advanceTo(T)
    pushKline('BTCUSDT', T - M15)
    pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => expect(await decisionsAt(T)).toEqual({ BTCUSDT: 'blocked:paused', ETHUSDT: 'blocked:paused' }), WAIT)

    pushMark('ETHUSDT', 2_440)
    await vi.waitFor(async () => {
      const { items } = await t.repos.positions.listClosed(session.id)
      expect(items.map((c) => ({ id: c.id, reason: c.closeReason }))).toEqual([{ id: eth.id, reason: 'stop' }])
    }, WAIT)
  })

  it('el latido escribe la versión de ajustes aplicada', async () => {
    const { clock } = await start()
    await clock.advance(10_000)
    await vi.waitFor(async () => expect((await t.repos.bot.get(session.id))?.settingsVersionApplied).toBe(1), WAIT)
    const row = await t.repos.settings.get(session.id)
    const universe = { ...row!.config.universe, topN: 3 }
    expect((await t.repos.settings.update(session.id, { universe }, row!.version)).ok).toBe(true)
    await clock.advance(10_000)
    await vi.waitFor(async () => {
      const status = await t.repos.bot.get(session.id)
      expect(status).toMatchObject({ settingsVersionApplied: 2, phase: 'live' })
    }, WAIT)
  })
})
