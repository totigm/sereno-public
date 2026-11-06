import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RealReadinessInput } from '@sereno/db'
import { REAL_CHECK_IDS, type BinanceEnv } from '@sereno/shared'
import { FakeBinance } from '../../src/binance/fake/server'
import { REAL_HOSTS, type BotConfig } from '../../src/config'
import { MINUTE_MS, Scheduler } from '../../src/live/scheduler'
import type { ChecksTrade } from '../../src/real/checks'
import { READINESS_PERIOD_MS, ReadinessWriter } from '../../src/real/readiness'
import { tradeFor } from '../helpers/binance'
import { openTestDb, type TestDb } from '../helpers/db'
import { ManualClock } from '../helpers/manual-clock'

const T0 = Date.parse('2026-11-01T12:01:00Z')
const INSTANCE = 'inst_t10_readiness'

const realConfig = (patch: Partial<BotConfig['real']> = {}): BotConfig['real'] => ({
  enabled: false,
  env: 'testnet',
  apiKey: null,
  apiSecret: null,
  ...REAL_HOSTS.testnet,
  ...patch,
})

let t: TestDb
let fake: FakeBinance

beforeAll(async () => {
  t = await openTestDb()
  fake = await FakeBinance.start()
})

afterAll(async () => {
  await t.query('delete from real_readiness')
  await t.close()
  await fake.stop()
})

beforeEach(async () => {
  await t.query('delete from real_readiness')
  fake.reset()
  fake.now = () => T0
})

const rowFor = async (env: BinanceEnv) => {
  const row = await t.repos.realReadiness.latest()
  expect(row?.env).toBe(env)
  return row!
}

describe('ReadinessWriter', () => {
  it('escribe la fila sin claves con keysPresent false y checks[0].status fail', async () => {
    const writer = new ReadinessWriter({
      repos: t.repos,
      trade: null,
      config: realConfig(),
      instanceId: INSTANCE,
      clock: { now: () => T0 },
      session: () => null,
    })
    const checks = await writer.run()
    const row = await rowFor('testnet')
    expect(row).toMatchObject({ enabled: false, keysPresent: false, walletAvailable: null, instanceId: INSTANCE })
    expect(row.checks[0]).toMatchObject({ id: 'keys', status: 'fail' })
    expect(row.checks.slice(1).every((c) => c.status === 'skipped')).toBe(true)
    expect(row.checks).toEqual(checks)
    expect(fake.requests).toEqual([])
  })

  it('con claves revisa la cuenta, guarda lo disponible y deja los chequeos a mano', async () => {
    fake.trading.config({ wallet: 120, dualSide: true })
    const writer = new ReadinessWriter({
      repos: t.repos,
      trade: tradeFor(fake).trade,
      config: realConfig({ enabled: true, env: 'mainnet', apiKey: 'k', apiSecret: 's', ...REAL_HOSTS.mainnet }),
      instanceId: INSTANCE,
      clock: { now: () => T0 },
      session: () => ({ id: 'ses_real', env: 'mainnet', saldo: 50, usesMargin: false }),
    })
    expect(writer.latest).toEqual([])
    await writer.run()
    const row = await rowFor('mainnet')
    expect(row).toMatchObject({ enabled: true, keysPresent: true, walletAvailable: 120 })
    expect(row.checks.map((c) => c.id)).toEqual([...REAL_CHECK_IDS])
    expect(row.checks.find((c) => c.id === 'one_way')?.status).toBe('fail')
    expect(writer.latest).toEqual(row.checks)
  })

  it('corre al arrancar y en cada borde de 5 min, con la sesión de ese momento', async () => {
    // T0 es 12:01: la primera corrida programada cae en el borde de las 12:05.
    const clock = new ManualClock(T0)
    fake.now = clock.now
    let saldo = 0
    let writes = 0
    const realReadiness = {
      ...t.repos.realReadiness,
      upsert: async (row: RealReadinessInput) => {
        await t.repos.realReadiness.upsert(row)
        writes += 1
      },
    }
    const writer = new ReadinessWriter({
      repos: { realReadiness },
      trade: tradeFor(fake).trade,
      config: realConfig({ enabled: true, apiKey: 'k', apiSecret: 's' }),
      instanceId: INSTANCE,
      clock,
      session: () => (saldo === 0 ? null : { id: 'ses_real', env: 'testnet', saldo, usesMargin: false }),
    })
    const scheduler = new Scheduler({ clock, onError: (job, err) => expect.unreachable(`${job}: ${String(err)}`) })
    const atStart = await writer.start(scheduler)
    expect(atStart.find((c) => c.id === 'wallet')?.status).toBe('skipped')
    expect(writes).toBe(1)
    expect(READINESS_PERIOD_MS).toBe(5 * MINUTE_MS)

    saldo = 10_000
    await clock.advance(4 * MINUTE_MS)
    await waitFor(async () => writes === 2)
    expect((await rowFor('testnet')).checks.find((c) => c.id === 'wallet')?.status).toBe('fail')
    expect(writer.latest.find((c) => c.id === 'wallet')?.status).toBe('fail')

    await clock.advance(READINESS_PERIOD_MS - 1)
    expect(writes).toBe(2)
    await clock.advance(1)
    await waitFor(async () => writes === 3)
    scheduler.stop()
  })

  it('dos corridas nunca se pisan: la que se pide durante otra corre después, y las que esperan se juntan', async () => {
    const trade = new SlowTrade()
    let saldo = 10
    const writer = new ReadinessWriter({
      repos: t.repos,
      trade,
      config: realConfig({ enabled: true, apiKey: 'k', apiSecret: 's' }),
      instanceId: INSTANCE,
      clock: { now: () => T0 },
      session: () => ({ id: 'ses_real', env: 'testnet', saldo, usesMargin: false }),
    })
    const first = writer.run()
    saldo = 99
    const second = writer.run()
    const third = writer.run()
    expect(third).toBe(second)
    // La segunda no le pide nada a Binance hasta que termina la primera.
    expect(trade.balanceReads).toBe(1)
    trade.release(50)
    await first
    await waitFor(async () => trade.balanceReads === 2)
    trade.release(50)
    const last = await second
    expect(trade.balanceReads).toBe(2)
    // Ganó la última pedida: la que leyó la sesión de después.
    expect(last.find((c) => c.id === 'wallet')?.status).toBe('fail')
    expect((await rowFor('testnet')).checks).toEqual(last)
    expect(writer.latest).toEqual(last)
  })

  it('los chequeos hechos para otra sesión (o sin ninguna) no habilitan a la nueva hasta la próxima corrida', async () => {
    let current: { id: string; env: BinanceEnv; saldo: number; usesMargin: boolean } | null = null
    fake.trading.config({ wallet: 100 })
    const writer = new ReadinessWriter({
      repos: t.repos,
      trade: tradeFor(fake).trade,
      config: realConfig({ enabled: true, apiKey: 'k', apiSecret: 's' }),
      instanceId: INSTANCE,
      clock: { now: () => T0 },
      session: () => current,
    })
    await writer.run()
    expect(writer.latest.length).toBe(REAL_CHECK_IDS.length)
    current = { id: 'ses_a', env: 'testnet', saldo: 50, usesMargin: false }
    expect(writer.latest).toEqual([])
    await writer.run()
    expect(writer.latest.find((c) => c.id === 'wallet')?.status).toBe('ok')
    current = { ...current, id: 'ses_b' }
    expect(writer.latest).toEqual([])
  })
})

// Un Binance de testnet en orden cuya billetera contesta recién cuando el test la suelta.
class SlowTrade implements ChecksTrade {
  balanceReads = 0
  private readonly waiting: ((balance: { wallet: number; available: number }) => void)[] = []

  release(amount: number): void {
    this.waiting.shift()?.({ wallet: amount, available: amount })
  }

  usdtBalance(): Promise<{ wallet: number; available: number }> {
    this.balanceReads += 1
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async apiRestrictions(): Promise<null> {
    return null
  }

  async dualSide(): Promise<boolean> {
    return false
  }

  async serverTime(): Promise<number> {
    return T0
  }

  async multiAssets(): Promise<boolean> {
    return false
  }

  async feeBurn(): Promise<boolean> {
    return false
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('no pasó a tiempo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
