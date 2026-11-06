import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { FAKE_API_KEY, FAKE_API_SECRET } from '../../src/binance/fake/account-fixtures'
import { FakeBinance } from '../../src/binance/fake/server'
import { RateLimiter } from '../../src/binance/rate-limiter'
import { BinanceRest } from '../../src/binance/rest'
import { BINANCE_LIMITS } from '../../src/config'
import { KEY_REJECTED_MESSAGE } from '../../src/jobs/account-tiers'
import { accountTiersHook } from '../../src/live/hooks'
import type { AccountHookContext } from '../../src/live/live-types'
import { silentLogger } from '../../src/logger'
import { openTestDb, type TestDb } from '../helpers/db'
import { createActiveSession, dropSession, startHarness, type Harness } from '../helpers/live'

// El trabajo diario de la cuenta corre a las 00:10 UTC (después de los contratos de las 00:05).
const START = Date.UTC(2026, 9, 31, 23, 58, 0)
const DAILY = Date.UTC(2026, 10, 1, 0, 10, 0)
const WAIT = { timeout: 5_000, interval: 25 }

let fake: FakeBinance
let t: TestDb
let session: SessionRow
let h: Harness | null = null

// La clave de sólo lectura contra el Binance falso. Su reloj es el real y el del falso, el
// manual del runtime: el desfase medido con /fapi/v1/time los empareja.
function signedRest(): BinanceRest {
  return new BinanceRest({ baseUrl: fake.baseUrl, limiter: new RateLimiter({ ...BINANCE_LIMITS }), apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET, maxRetries: 0 })
}

async function start(accountTiers: (ctx: AccountHookContext) => Promise<void>): Promise<Harness> {
  h = await startHarness({ t, fake, start: START, hooks: { accountTiers } })
  await h.runtime.ready()
  h.openSocket()
  return h
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
  session = await createActiveSession(t)
})

afterEach(async () => {
  await h?.runtime.stop()
  h = null
  await dropSession(t, session.id)
})

describe('runtime en vivo: mmr y comisiones de la cuenta', { timeout: 30_000 }, () => {
  it('corre al tomar la sesión, una sola vez, y después todos los días a las 00:10 UTC', async () => {
    const calls: string[] = []
    const { clock } = await start(async (ctx) => void calls.push(ctx.sessionId))
    await vi.waitFor(() => expect(calls).toEqual([session.id]), WAIT)
    await clock.advanceTo(DAILY - 1_000)
    expect(calls).toHaveLength(1)
    await clock.advanceTo(DAILY + 1_000)
    await vi.waitFor(() => expect(calls).toEqual([session.id, session.id]), WAIT)
  })

  it('un trabajo que falla no frena el arranque: queda en los errores recientes', async () => {
    const { clock, runtime } = await start(async () => {
      throw new Error('se cayó la base')
    })
    await vi.waitFor(async () => {
      await clock.advance(10_000)
      const status = await t.repos.bot.get(session.id)
      expect(status?.recentErrors.map((e) => e.message)).toContain('Falló el trabajo cuenta: se cayó la base')
    }, WAIT)
    expect(runtime.status().phase).toBe('live')
  })

  it('con la clave rechazada (-2015): una línea clara en recentErrors, los ajustes intactos y el runtime sigue', async () => {
    fake.rejectKey()
    const { clock, runtime } = await start(accountTiersHook({ rest: signedRest(), logger: silentLogger }))
    await vi.waitFor(async () => {
      await clock.advance(10_000)
      const status = await t.repos.bot.get(session.id)
      expect(status?.recentErrors.map((e) => e.message)).toContain(KEY_REJECTED_MESSAGE)
    }, WAIT)
    expect(runtime.status().phase).toBe('live')
    expect((await t.repos.settings.get(session.id))?.version).toBe(1)
    expect(fake.requests.filter((r) => r.path === '/fapi/v1/leverageBracket')).toHaveLength(1)
  })

  it('al apagar guarda y suelta el lease sin esperar una corrida lenta de Binance', async () => {
    let finish!: () => void
    const slow = new Promise<void>((resolve) => (finish = resolve))
    let started = false
    const { runtime } = await start(async () => {
      started = true
      await slow
    })
    await vi.waitFor(() => expect(started).toBe(true), WAIT)
    const stopped = runtime.stop()
    // Otra instancia puede tomar la sesión mientras la corrida sigue colgada.
    await vi.waitFor(async () => expect(await t.repos.bot.acquireLease(session.id, 'otra-instancia', 30_000)).toBe(true), WAIT)
    finish()
    await stopped
    h = null
  })

  it('con clave guarda el mmr y las comisiones de la cuenta y la sesión los aplica', async () => {
    const { clock } = await start(accountTiersHook({ rest: signedRest(), logger: silentLogger }))
    await vi.waitFor(async () => {
      const row = await t.repos.settings.get(session.id)
      expect(row).toMatchObject({ version: 2, config: { risk: { takerFeeRate: 0.00045, makerFeeRate: 0.00018 } } })
    }, WAIT)
    await vi.waitFor(async () => {
      await clock.advance(10_000)
      expect((await t.repos.bot.get(session.id))?.settingsVersionApplied).toBe(2)
    }, WAIT)
  })
})
