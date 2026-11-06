import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DirectDb } from '../../src/client'
import { createBotRepo, type HeartbeatInput } from '../../src/repos/bot'
import { botLease, botStatus, sessions } from '../../src/schema'
import { openTestDb, seedSession, sleep, truncate } from './helpers'

const SESSION = 'ses_bot'
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, botStatus, botLease)
  await seedSession(db, SESSION)
})

function latido(instanceId: string, patch: Partial<HeartbeatInput> = {}): HeartbeatInput {
  return {
    sessionId: SESSION,
    instanceId,
    phase: 'live',
    warmProgress: 30,
    universeSize: 30,
    lastCycleAt: new Date('2026-10-31T12:00:00Z'),
    settingsVersionApplied: 3,
    degradedSymbols: [],
    flags: { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false },
    recentErrors: [],
    botVersion: '0.1.0',
    ...patch,
  }
}

describe('botRepo.acquireLease', () => {
  it('falla para una segunda instancia mientras el lease está vigente y pasa cuando venció', async () => {
    const repo = createBotRepo(db)
    expect(await repo.acquireLease(SESSION, 'bot-a', 300)).toBe(true)
    expect(await repo.acquireLease(SESSION, 'bot-b', 300)).toBe(false)
    await sleep(400)
    expect(await repo.acquireLease(SESSION, 'bot-b', 30_000)).toBe(true)
    // Ahora el que quedó afuera es el primero.
    expect(await repo.acquireLease(SESSION, 'bot-a', 30_000)).toBe(false)
    const [lease] = await db.select().from(botLease)
    expect(lease?.instanceId).toBe('bot-b')
  })

  it('el dueño lo renueva y corre el vencimiento', async () => {
    const repo = createBotRepo(db)
    await repo.acquireLease(SESSION, 'bot-a', 1_000)
    const [antes] = await db.select().from(botLease)
    expect(await repo.acquireLease(SESSION, 'bot-a', 60_000)).toBe(true)
    const [despues] = await db.select().from(botLease)
    expect((despues?.leaseUntil.getTime() ?? 0) - (antes?.leaseUntil.getTime() ?? 0)).toBeGreaterThan(58_000)
  })

  it('release suelta el lease sólo si es propio y otro lo toma enseguida', async () => {
    const repo = createBotRepo(db)
    await repo.acquireLease(SESSION, 'bot-a', 30_000)
    expect(await repo.releaseLease(SESSION, 'bot-b')).toBe(false)
    expect(await repo.acquireLease(SESSION, 'bot-b', 30_000)).toBe(false)
    expect(await repo.releaseLease(SESSION, 'bot-a')).toBe(true)
    expect(await repo.acquireLease(SESSION, 'bot-b', 30_000)).toBe(true)
  })
})

describe('botRepo.heartbeat / get', () => {
  it('get es null antes del primer latido; el latido crea y después reescribe la fila', async () => {
    const repo = createBotRepo(db)
    expect(await repo.get(SESSION)).toBeNull()
    await repo.acquireLease(SESSION, 'bot-a', 30_000)
    expect(await repo.heartbeat(latido('bot-a', { phase: 'warming', warmProgress: 18 }))).toBe(true)
    const primero = await repo.get(SESSION)
    expect(primero).toMatchObject({ instanceId: 'bot-a', phase: 'warming', warmProgress: 18 })
    expect(primero?.lastHeartbeat).toBeInstanceOf(Date)
    await sleep(5)
    expect(await repo.heartbeat(latido('bot-a', { degradedSymbols: ['SOLUSDT'] }))).toBe(true)
    const segundo = await repo.get(SESSION)
    expect(segundo).toMatchObject({ phase: 'live', degradedSymbols: ['SOLUSDT'], settingsVersionApplied: 3 })
    expect(segundo?.lastHeartbeat.getTime()).toBeGreaterThan(primero?.lastHeartbeat.getTime() ?? Infinity)
  })

  it('una instancia sin lease no pisa el estado de la que lo tiene', async () => {
    const repo = createBotRepo(db)
    await repo.acquireLease(SESSION, 'bot-a', 30_000)
    await repo.heartbeat(latido('bot-a'))
    expect(await repo.heartbeat(latido('bot-b', { phase: 'waiting_lease' }))).toBe(false)
    expect(await repo.get(SESSION)).toMatchObject({ instanceId: 'bot-a', phase: 'live' })
  })

  it('cuando el lease de la dueña venció, la que espera puede decir que espera', async () => {
    const repo = createBotRepo(db)
    await repo.acquireLease(SESSION, 'bot-a', 100)
    await repo.heartbeat(latido('bot-a'))
    await sleep(200)
    expect(await repo.heartbeat(latido('bot-b', { phase: 'waiting_lease' }))).toBe(true)
    expect(await repo.get(SESSION)).toMatchObject({ instanceId: 'bot-b', phase: 'waiting_lease' })
  })

  it('guarda el gate de la sesión real y lo deja en null cuando el latido no lo trae', async () => {
    const repo = createBotRepo(db)
    await repo.acquireLease(SESSION, 'bot-a', 30_000)
    const gate = { mode: 'reduce_only', missing: ['SERENO_REAL_TRADING=on'] } as const
    await repo.heartbeat(latido('bot-a', { phase: 'off', real: { ...gate, missing: [...gate.missing] } }))
    expect(await repo.get(SESSION)).toMatchObject({ phase: 'off', real: gate })
    await repo.heartbeat(latido('bot-a'))
    expect(await repo.get(SESSION)).toMatchObject({ phase: 'live', real: null })
  })
})
