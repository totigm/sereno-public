import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { FakeBinance } from '../../src/binance/fake/server'
import { shutdownOnSignals, type SignalSource } from '../../src/live/shutdown'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, dropSession, seedOpen, startHarness, type Harness } from '../helpers/live'

// Lo que el runtime hace solo con el paso del tiempo y cómo deja de operar.
const START = Date.UTC(2026, 9, 31, 12, 5, 0)
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

async function start(instanceId?: string): Promise<Harness> {
  h = await startHarness({ t, fake, start: START, ...(instanceId ? { instanceId } : {}) })
  await h.runtime.ready()
  h.openSocket()
  return h
}

async function leaseHolder(): Promise<string | null> {
  const rows = await t.db.$client.query<{ instance_id: string }>('select instance_id from bot_lease where session_id = $1', [session.id])
  return rows.rows[0]?.instance_id ?? null
}

describe('runtime en vivo: trabajos y apagado', { timeout: 30_000 }, () => {
  it('cada 5 s reescribe el estado de mercado y cada minuto deja un punto de equity', async () => {
    const { clock, pushMark } = await start()
    pushMark('ETHUSDT', 2_500)
    await clock.advance(5_000)
    await vi.waitFor(async () => {
      const row = await t.repos.market.get(session.id)
      expect(row?.symbols.find((s) => s.symbol === 'ETHUSDT')).toMatchObject({ markPrice: 2_500, state: 'ready' })
    }, WAIT)
    const version = (await t.repos.market.get(session.id))!.version
    pushMark('ETHUSDT', 2_510)
    await clock.advance(5_000)
    await vi.waitFor(async () => {
      const row = await t.repos.market.get(session.id)
      expect(row?.version).toBeGreaterThan(version)
      expect(row?.symbols.find((s) => s.symbol === 'ETHUSDT')?.markPrice).toBe(2_510)
    }, WAIT)

    await clock.advance(60_000)
    await vi.waitFor(async () => {
      const minutes = await t.repos.equity.series(session.id, START, START + 120_000, 'minute')
      expect(minutes.length).toBeGreaterThanOrEqual(1)
      expect(minutes[0]).toMatchObject({ at: START + 60_000, equity: 1_000 })
    }, WAIT)
  })

  it('si otra instancia se queda con el lease, deja de operar y no escribe nada más', async () => {
    const eth = await seedOpen(t, session.id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_450, qty: 0.1, openedAt: START - 3_600_000 })
    const { clock, runtime, pushMark } = await start('primera')
    // El lease venció (el proceso se colgó, por ejemplo) y otra instancia lo tomó.
    await t.query(`update bot_lease set instance_id = 'segunda', lease_until = now() + interval '1 minute' where session_id = $1`, [session.id])
    await clock.advance(10_000)
    await vi.waitFor(() => expect(runtime.status()).toEqual({ phase: 'waiting_lease', sessionId: session.id }), WAIT)
    pushMark('ETHUSDT', 2_440)
    await clock.advance(3_000)
    expect((await t.repos.positions.listOpen(session.id)).map((p) => p.id)).toEqual([eth.id])
    expect(await leaseHolder()).toBe('segunda')
  })

  it('SIGINT apaga una sola vez: último latido y lease suelto', async () => {
    const { clock, runtime } = await start('a-apagar')
    expect(await leaseHolder()).toBe('a-apagar')
    const before = (await t.repos.bot.get(session.id))!.lastHeartbeat
    await clock.advance(1_000)
    const signals = new EventEmitter()
    let stops = 0
    const done = shutdownOnSignals(signals as SignalSource, async () => {
      stops += 1
      await runtime.stop()
    })
    signals.emit('SIGINT', 'SIGINT')
    signals.emit('SIGTERM', 'SIGTERM')
    await done
    expect(stops).toBe(1)
    expect(await leaseHolder()).toBeNull()
    expect((await t.repos.bot.get(session.id))!.lastHeartbeat.getTime()).toBeGreaterThan(before.getTime())
    h = null
  })
})
