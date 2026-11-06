// @vitest-environment node
import { eq, sql } from 'drizzle-orm'
import { marketSnapshot, type DirectDb } from '@sereno/db'
import { refresh } from 'next/cache'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelCommand, enqueueCommand } from '@/lib/actions/commands'
import { archiveSession, createSession } from '@/lib/actions/session'
import { setPause, updateSettings } from '@/lib/actions/settings'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { archiveStrayActive, dropSessions, holdActiveSessions, seedRealSession, seedSession, testSessionId, type TestDb } from '../db'
import { position } from '../fixtures'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())
vi.mock('@/lib/session', () => ({ requireSession: vi.fn(async () => ({ user: { email: 'owner@example.com' } })) }))
vi.mock('next/cache', () => ({ refresh: vi.fn() }))

// Crea sesiones activas: se turna con los otros archivos que también las crean.
const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const created: string[] = []
const OWNER = 'owner@example.com'
let release: () => Promise<void>

async function freshReal(label: string): Promise<string> {
  const id = await seedRealSession(t, testSessionId(label))
  created.push(id)
  return id
}

async function freshActive(label: string): Promise<string> {
  const id = await seedSession(t, testSessionId(label), { status: 'active', startedAt: Date.now() - 86_400_000 })
  created.push(id)
  return id
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await t.repos.sessions.get(id))?.status
}

beforeAll(async () => {
  release = await holdActiveSessions(t)
})

beforeEach(async () => {
  await archiveStrayActive(t)
})

afterAll(async () => {
  // Las que crea `createSession` se anotan a mano en `created`; se borran todas.
  await dropSessions(t, created)
  await release()
  await t.db.$client.end()
})

describe('updateSettings (optimistic locking)', () => {
  it('guarda con la versión vista, sube la versión y registra quién', async () => {
    const id = await freshActive('settings')
    const risk = { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.005 }
    expect(await updateSettings(id, { risk }, 1)).toEqual({ ok: true, version: 2 })
    const row = await t.repos.settings.get(id)
    expect(row?.config.risk.riskPerTrade).toBe(0.005)
    expect(row?.updatedBy).toBe(OWNER)
    expect((await t.repos.settings.history(id)).map((h) => [h.version, h.changedBy])).toEqual([
      [2, OWNER],
      [1, OWNER],
    ])
  })

  it('con una versión vieja no escribe y devuelve la vigente', async () => {
    const id = await freshActive('conflict')
    expect(await updateSettings(id, { mode: 'custom' }, 1)).toEqual({ ok: true, version: 2 })
    vi.mocked(refresh).mockClear()
    const stale = await updateSettings(id, { mode: 'auto' }, 1)
    // Trae la versión nueva para mostrarla y refresca la página, como dice el mensaje.
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', version: 2, settings: { mode: 'custom' } })
    expect(refresh).toHaveBeenCalledOnce()
    expect((await t.repos.settings.get(id))?.config.mode).toBe('custom')
  })

  it('rechaza un valor fuera de rango sin tocar nada', async () => {
    const id = await freshActive('invalid')
    const result = await updateSettings(id, { risk: { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.5 } }, 1)
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await t.repos.settings.get(id))?.version).toBe(1)
  })

  it('una simulación archivada queda en sólo lectura', async () => {
    const id = await seedSession(t, testSessionId('archived'))
    created.push(id)
    expect(await updateSettings(id, { mode: 'custom' }, 1)).toMatchObject({ ok: false, reason: 'not_active' })
  })

  it('setPause pone la pausa con quién y cuándo desde el servidor', async () => {
    const id = await freshActive('pause')
    expect(await setPause(id, true, 1)).toEqual({ ok: true, version: 2 })
    const pause = (await t.repos.settings.get(id))?.config.pause
    expect(pause).toMatchObject({ paused: true, by: 'user', reason: null })
    expect(Date.parse(pause?.at ?? '')).toBeGreaterThan(Date.now() - 60_000)
    expect(await setPause(id, false, 2)).toEqual({ ok: true, version: 3 })
    expect((await t.repos.settings.get(id))?.config.pause).toEqual({ paused: false, by: null, at: null, reason: null })
  })
})

describe('createSession', () => {
  it('archiva la activa y crea la nueva con el capital, el blindaje y el modo pedidos', async () => {
    const old = await freshActive('old')
    const result = await createSession({ capital: 2500, protectPct: 0.5, mode: 'custom', learningOrigin: 'zero' })
    if (!result.ok) throw new Error(result.message)
    created.push(result.sessionId)
    expect(result.archived).toEqual({ closed: 0, leftOpen: 0, markAt: null })
    expect(await statusOf(old)).toBe('archived')
    const fresh = await t.repos.sessions.get(result.sessionId)
    expect(fresh).toMatchObject({ status: 'active', capitalInicial: 2500 })
    const config = (await t.repos.settings.get(result.sessionId))?.config
    expect(config?.mode).toBe('custom')
    expect(config?.capital.protectPct).toBe(0.5)
  })

  it('si la nueva no se puede crear, la actual sigue activa (todo en una transacción)', async () => {
    const old = await freshActive('rollback')
    const result = await createSession({ capital: 1000, protectPct: 0.7, mode: 'auto', learningOrigin: 'replay:ses_que_no_existe' })
    expect(result).toMatchObject({ ok: false, reason: 'learning_missing' })
    expect(await statusOf(old)).toBe('active')
  })

  it('con abiertas y sin precio actual no archiva nada y lo dice', async () => {
    const old = await freshActive('stale')
    await t.repos.positions.upsertOpen(old, position('stale-open'))
    await t.repos.market.upsert(old, [{ symbol: 'SOLUSDT', markPrice: 127.5, change24h: 0, sPrime: 0, lean: 0, state: 'in_position' }])
    await t.db
      .update(marketSnapshot)
      .set({ updatedAt: sql`now() - interval '10 minutes'` })
      .where(eq(marketSnapshot.sessionId, old))
    const result = await createSession({ capital: 1000, protectPct: 0.7, mode: 'auto', learningOrigin: 'zero' })
    expect(result).toMatchObject({ ok: false, reason: 'stale_mark' })
    expect(await statusOf(old)).toBe('active')

    const forced = await createSession({ capital: 1000, protectPct: 0.7, mode: 'auto', learningOrigin: 'zero', closeOpen: false })
    if (!forced.ok) throw new Error(forced.message)
    created.push(forced.sessionId)
    expect(await statusOf(old)).toBe('archived')
  })
})

describe('con una sesión real activa', () => {
  it('Nueva simulación con una real activa archiva sólo la de papel', async () => {
    const paper = await freshActive('paper-with-real')
    const real = await freshReal('real-kept')
    const result = await createSession({ capital: 1000, protectPct: 0.7, mode: 'auto', learningOrigin: 'zero' })
    if (!result.ok) throw new Error(result.message)
    created.push(result.sessionId)
    expect(await statusOf(paper)).toBe('archived')
    expect(await t.repos.sessions.get(real)).toMatchObject({ status: 'active', realStatus: 'on' })
    expect((await t.repos.sessions.getActive('paper_live'))?.id).toBe(result.sessionId)
  })

  it('archivar una sesión real devuelve real_session', async () => {
    const real = await freshReal('real-archive')
    expect(await archiveSession({ sessionId: real })).toEqual({
      ok: false,
      reason: 'real_session',
      message: 'La sesión con plata real se apaga desde Ajustes › Plata real.',
    })
    expect(await statusOf(real)).toBe('active')
  })

  it('cancela un comando de la sesión real mientras el bot no lo tomó', async () => {
    await freshActive('paper-cancel')
    const real = await freshReal('real-cancel')
    const commandId = crypto.randomUUID()
    await t.repos.commands.enqueue({ id: commandId, sessionId: real, kind: 'close_position', payload: { symbol: 'SOLUSDT' }, requestedBy: OWNER })
    expect(await cancelCommand(commandId)).toEqual({ ok: true })
    expect((await t.repos.commands.listRecent(real))[0]?.status).toBe('cancelled')
  })
})

describe('enqueueCommand / cancelCommand', () => {
  it('el uuid del cliente hace idempotente el envío y `requestedBy` sale de la sesión', async () => {
    const id = await freshActive('commands')
    const commandId = crypto.randomUUID()
    const input = { id: commandId, sessionId: id, kind: 'close_position' as const, payload: { symbol: 'SOLUSDT' } }
    expect(await enqueueCommand(input)).toEqual({ ok: true, id: commandId, duplicate: false })
    expect(await enqueueCommand(input)).toEqual({ ok: true, id: commandId, duplicate: true })
    const [row] = await t.repos.commands.listRecent(id)
    expect(row).toMatchObject({ id: commandId, requestedBy: OWNER, status: 'pending' })

    expect(await cancelCommand(commandId)).toEqual({ ok: true })
    expect(await cancelCommand(commandId)).toMatchObject({ ok: false, reason: 'not_pending' })
  })

  it('no cancela un comando de otra sesión: sólo los de la simulación activa', async () => {
    const archived = await seedSession(t, testSessionId('cmd-cancel-other'))
    created.push(archived)
    const commandId = crypto.randomUUID()
    await t.repos.commands.enqueue({ id: commandId, sessionId: archived, kind: 'close_all', requestedBy: OWNER })
    await freshActive('cmd-cancel-active')

    expect(await cancelCommand(commandId)).toEqual({
      ok: false,
      reason: 'other_session',
      message: 'Ese comando es de otra simulación, no de la activa: no lo cancelé.',
    })
    expect((await t.repos.commands.listRecent(archived))[0]?.status).toBe('pending')
    expect(await cancelCommand(crypto.randomUUID())).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('sin simulación activa no cancela nada', async () => {
    const archived = await seedSession(t, testSessionId('cmd-cancel-none'))
    created.push(archived)
    const commandId = crypto.randomUUID()
    await t.repos.commands.enqueue({ id: commandId, sessionId: archived, kind: 'close_all', requestedBy: OWNER })

    // `beforeEach` ya archivó cualquier activa.
    expect(await cancelCommand(commandId)).toMatchObject({ ok: false, reason: 'not_active' })
    expect((await t.repos.commands.listRecent(archived))[0]?.status).toBe('pending')
  })

  it('no encola sobre una sesión que no es la activa', async () => {
    const archived = await seedSession(t, testSessionId('cmd-archived'))
    created.push(archived)
    const result = await enqueueCommand({ id: crypto.randomUUID(), sessionId: archived, kind: 'close_all', payload: {} })
    expect(result).toMatchObject({ ok: false, reason: 'not_active' })
    expect(await t.repos.commands.listRecent(archived)).toEqual([])
  })

  it('valida el payload con el zod compartido', async () => {
    const id = await freshActive('cmd-invalid')
    const result = await enqueueCommand({ id: 'no-es-un-uuid', sessionId: id, kind: 'close_all', payload: {} })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
