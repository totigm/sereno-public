import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RealCheck } from '@sereno/shared'
import type { DirectDb } from '../../src/client'
import { createRealEventsRepo, createRealReadinessRepo, type RealReadinessInput } from '../../src/repos/real'
import { realEvents, realReadiness, sessions } from '../../src/schema'
import { openTestDb, seedSession, T0, truncate } from './helpers'

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, realReadiness, realEvents)
})

const CHECKS: RealCheck[] = [
  { id: 'keys', status: 'ok', detail: 'Están cargadas.' },
  { id: 'no_withdrawals', status: 'skipped', detail: 'En testnet no existe: lo salteo.' },
]

function readiness(env: RealReadinessInput['env'], patch: Partial<RealReadinessInput> = {}): RealReadinessInput {
  return { env, enabled: true, keysPresent: true, checks: CHECKS, walletAvailable: 120.5, instanceId: 'bot-a', ...patch }
}

describe('realReadinessRepo', () => {
  it('upsert dos veces el mismo entorno deja una sola fila, con lo último', async () => {
    const repo = createRealReadinessRepo(db)
    await repo.upsert(readiness('testnet'))
    const failed: RealCheck[] = [{ id: 'keys', status: 'fail', detail: 'Faltan.' }]
    await repo.upsert(readiness('testnet', { enabled: false, keysPresent: false, checks: failed, walletAvailable: null, instanceId: 'bot-b' }))
    const rows = await db.select().from(realReadiness)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ env: 'testnet', enabled: false, keysPresent: false, checks: failed, walletAvailable: null, instanceId: 'bot-b' })
    expect(rows[0]?.checkedAt).toBeInstanceOf(Date)
  })

  it('latest trae los chequeos más nuevos, de cualquier entorno', async () => {
    const repo = createRealReadinessRepo(db)
    expect(await repo.latest()).toBeNull()
    await repo.upsert(readiness('mainnet'))
    await repo.upsert(readiness('testnet'))
    expect((await repo.latest())?.env).toBe('testnet')
    await repo.upsert(readiness('mainnet', { walletAvailable: 80 }))
    expect(await repo.latest()).toMatchObject({ env: 'mainnet', walletAvailable: 80, checks: CHECKS })
  })
})

describe('realEventsRepo', () => {
  const at = T0.getTime()

  it('append guarda los eventos y list los trae en [from, to), en orden y sólo de esa sesión', async () => {
    await seedSession(db, 'real', { kind: 'live', status: 'active' })
    await seedSession(db, 'otra', { kind: 'live' })
    const repo = createRealEventsRepo(db)
    await repo.append('real', [
      { at: at + 1000, kind: 'on', phrase: 'Prendí la operación con plata real.' },
      { at, kind: 'rejected', symbol: 'SOLUSDT', phrase: 'Binance rechazó la orden.', data: { code: -2019 } },
    ])
    await repo.append('otra', [{ at, kind: 'off', phrase: 'Apagué la operación con plata real.' }])
    await repo.append('real', [])

    const first = await repo.list('real', { from: at, to: at + 1000 })
    expect(first).toEqual([
      { id: expect.any(Number), sessionId: 'real', at, kind: 'rejected', symbol: 'SOLUSDT', phrase: 'Binance rechazó la orden.', data: { code: -2019 } },
    ])
    const both = await repo.list('real', { from: at, to: at + 2000 })
    expect(both.map((e) => [e.kind, e.symbol, e.data])).toEqual([
      ['rejected', 'SOLUSDT', { code: -2019 }],
      ['on', null, {}],
    ])
    expect(await repo.list('real', { from: at + 2000, to: at + 3000 })).toEqual([])
  })
})
