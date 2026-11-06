import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Position } from '@sereno/core'
import type { CommandInput } from '@sereno/shared'
import type { SessionRow } from '@sereno/db'
import { FakeBinance } from '../../src/binance/fake/server'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, dropSession, seedOpen, startHarness, type Harness } from '../helpers/live'

const START = Date.UTC(2026, 9, 31, 12, 5, 0)
const WAIT = { timeout: 5_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let session: SessionRow
let h: Harness | null = null
let eth: Position
let btc: Position

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
  const openedAt = START - 3_600_000
  eth = await seedOpen(t, session.id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_400, qty: 0.1, openedAt })
  btc = await seedOpen(t, session.id, { symbol: 'BTCUSDT', side: 'short', entryPrice: 68_500, stopPrice: 69_500, qty: 0.001, openedAt })
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  await dropSession(t, session.id)
})

async function enqueue(kind: 'close_position' | 'close_all', payload: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await t.repos.commands.enqueue({ id, sessionId: session.id, kind, payload, requestedBy: 'toti@example.com' } as CommandInput)).toBe(true)
  return id
}

async function command(id: string) {
  return (await t.repos.commands.listRecent(session.id)).find((c) => c.id === id)
}

async function openIds(): Promise<string[]> {
  return (await t.repos.positions.listOpen(session.id)).map((p) => p.id).sort()
}

async function started(instanceId?: string): Promise<Harness> {
  h = await startHarness({ t, fake, start: START, ...(instanceId ? { instanceId } : {}) })
  await h.runtime.ready()
  return h
}

describe('comandos', { timeout: 30_000 }, () => {
  it('un close_position vencido queda expired y la posición sigue abierta', async () => {
    const id = await enqueue('close_position', { symbol: 'ETHUSDT' })
    await t.query(`update bot_commands set expires_at = now() - interval '1 second' where id = $1`, [id])
    const { clock } = await started()
    await clock.advance(3_000)
    await vi.waitFor(async () => expect((await command(id))?.status).toBe('expired'), WAIT)
    expect(await openIds()).toEqual([btc.id, eth.id].sort())
  })

  it('un close_position válido cierra la posición y queda done', async () => {
    const { clock } = await started()
    const id = await enqueue('close_position', { symbol: 'ETHUSDT' })
    await clock.advance(3_000)
    await vi.waitFor(async () => expect((await command(id))?.status).toBe('done'), WAIT)
    const { items } = await t.repos.positions.listClosed(session.id)
    expect(items.map((c) => ({ id: c.id, reason: c.closeReason }))).toEqual([{ id: eth.id, reason: 'manual' }])
    expect(await openIds()).toEqual([btc.id])
    expect((await command(id))?.result).toMatchObject({ ok: true, data: { positionId: eth.id } })
  })

  it('close_all cierra todas las reales', async () => {
    const { clock } = await started()
    const id = await enqueue('close_all')
    await clock.advance(3_000)
    await vi.waitFor(async () => expect((await command(id))?.status).toBe('done'), WAIT)
    expect(await openIds()).toEqual([])
    const { items } = await t.repos.positions.listClosed(session.id)
    expect(items.map((c) => c.closeReason)).toEqual(['close_all', 'close_all'])
  })

  it('una segunda instancia sin lease no ejecuta comandos ni abre posiciones', async () => {
    expect(await t.repos.bot.acquireLease(session.id, 'otra-instancia', 60_000)).toBe(true)
    const id = await enqueue('close_all')
    const { clock, runtime } = await started('segunda')
    await clock.advance(30_000)
    expect(runtime.status()).toEqual({ phase: 'waiting_lease', sessionId: session.id })
    expect((await command(id))?.status).toBe('pending')
    expect(await openIds()).toEqual([btc.id, eth.id].sort())
    expect(await t.repos.decisions.range(session.id, 0, START + 60_000)).toEqual([])
  })
})
