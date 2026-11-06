import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { FakeBinance } from '../../src/binance/fake/server'
import { openTestDb, type TestDb } from '../helpers/db'
import {
  backdate,
  commandRow,
  createActiveSession,
  dropSession,
  enqueueCommand,
  equityAt,
  fixedScorer,
  M15,
  seedOpen,
  setPause,
  startHarness,
  type Harness,
} from '../helpers/live'

// Ajustes que cambian con el bot andando: pausas que el poll de 3 s no llega a ver y
// cambios que obligan a rehacer el simulador.
const T = Date.UTC(2026, 9, 31, 12, 15, 0)
const START = T - 20_000
const HOUR = 3_600_000
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

async function start(): Promise<Harness> {
  h = await startHarness({ t, fake, start: START, scorer: fixedScorer({ ETHUSDT: 0.8 }) })
  await h.runtime.ready()
  h.openSocket()
  return h
}

async function actionsAt(at: number) {
  const rows = await t.repos.decisions.range(session.id, at, at + 1)
  return Object.fromEntries(rows.map((r) => [r.symbol, r.action]))
}

describe('runtime en vivo: ajustes', { timeout: 30_000 }, () => {
  it('si Toti levanta la pausa por drawdown antes de que el poll la vea, el motor igual reanuda', async () => {
    // Pico de 1.200 en la curva y el equity en 1.000: el primer ciclo dispara el drawdown.
    await backdate(t, session.id, START - 24 * HOUR, { 1: START - 24 * HOUR })
    await t.repos.equity.insert(session.id, equityAt(START - 3 * HOUR, 1_200))
    const { clock, pushKline } = await start()
    await clock.advanceTo(T)
    pushKline('BTCUSDT', T - M15)
    pushKline('ETHUSDT', T - M15)
    await vi.waitFor(async () => expect(await t.repos.settings.get(session.id)).toMatchObject({ version: 2, config: { pause: { paused: true, by: 'auto' } } }), WAIT)
    expect((await actionsAt(T)).ETHUSDT).toBe('blocked:drawdown_pause')

    // Toti reanuda antes del próximo poll: el bot pasa de la versión 1 a la 3 sin ver la 2.
    expect(await setPause(t, session.id, DEFAULT_SETTINGS.pause)).toBe(3)
    await clock.advance(10_000)
    await vi.waitFor(async () => expect(await t.repos.bot.get(session.id)).toMatchObject({ settingsVersionApplied: 3, phase: 'live', flags: { drawdownPause: false } }), WAIT)

    await clock.advanceTo(T + M15)
    pushKline('BTCUSDT', T)
    pushKline('ETHUSDT', T)
    await vi.waitFor(async () => expect(await actionsAt(T + M15)).toEqual({ BTCUSDT: 'wait', ETHUSDT: 'enter_long' }), WAIT)
  })

  it('rehacer el simulador mientras la pausa automática todavía no se escribió no levanta el drawdown', async () => {
    await backdate(t, session.id, START - 24 * HOUR, { 1: START - 24 * HOUR })
    await t.repos.equity.insert(session.id, equityAt(START - 3 * HOUR, 1_200))
    const { clock, pushKline } = await start()
    await clock.advanceTo(T)
    // Toti cambia las comisiones (versión 2) y la fila de ajustes queda tomada por otra
    // transacción: la pausa que el ciclo va a escribir espera, y el poll lee la versión 2.
    const row = await t.repos.settings.get(session.id)
    expect((await t.repos.settings.update(session.id, { risk: { ...row!.config.risk, takerFeeRate: 0.001 } }, row!.version)).ok).toBe(true)
    const locker = await openTestDb()
    const lock = await locker.db.$client.connect()
    try {
      await lock.query('begin')
      await lock.query('select 1 from settings where session_id = $1 for update', [session.id])
      pushKline('BTCUSDT', T - M15)
      pushKline('ETHUSDT', T - M15)
      await clock.advance(10_000)
      await vi.waitFor(async () => expect(await t.repos.bot.get(session.id)).toMatchObject({ settingsVersionApplied: 2, flags: { drawdownPause: true } }), WAIT)
      await lock.query('commit')
    } finally {
      lock.release()
      await locker.close()
    }
    await vi.waitFor(async () => expect(await t.repos.settings.get(session.id)).toMatchObject({ version: 3, config: { pause: { paused: true, by: 'auto' } } }), WAIT)
    await clock.advance(10_000)
    await vi.waitFor(async () => expect(await t.repos.bot.get(session.id)).toMatchObject({ settingsVersionApplied: 3, flags: { drawdownPause: true } }), WAIT)

    // La reanudación de Toti es la que la levanta.
    await setPause(t, session.id, DEFAULT_SETTINGS.pause)
    await clock.advance(10_000)
    await vi.waitFor(async () => expect(await t.repos.bot.get(session.id)).toMatchObject({ settingsVersionApplied: 4, flags: { drawdownPause: false } }), WAIT)
  })

  it('un cambio de comisiones rehace el simulador y el cierre siguiente las usa', async () => {
    const eth = await seedOpen(t, session.id, { symbol: 'ETHUSDT', entryPrice: 2_480, stopPrice: 2_400, qty: 0.1, openedAt: START - HOUR })
    const { clock, pushMark } = await start()
    pushMark('ETHUSDT', 2_500)
    // En la misma pasada de 3 s se aplican los ajustes y después se atienden los comandos.
    const row = await t.repos.settings.get(session.id)
    expect((await t.repos.settings.update(session.id, { risk: { ...row!.config.risk, takerFeeRate: 0.001 } }, row!.version)).ok).toBe(true)
    const close = await enqueueCommand(t, session.id, 'close_position', { symbol: 'ETHUSDT' })
    await clock.advance(3_000)
    await vi.waitFor(async () => expect((await commandRow(t, session.id, close))?.status).toBe('done'), WAIT)
    const closed = (await t.repos.positions.listEvents(eth.id)).find((e) => e.kind === 'close')
    const { fee, price, qty } = closed!.payload as { fee: number; price: number; qty: number }
    expect(fee / (price * qty)).toBeCloseTo(0.001, 9)
  })
})
