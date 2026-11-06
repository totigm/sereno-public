// @vitest-environment node
import { sql } from 'drizzle-orm'
import { realReadiness, type DirectDb } from '@sereno/db'
import { DEFAULT_SETTINGS, REAL_CHECK_IDS, type BinanceEnv, type RealCheck } from '@sereno/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealSession, turnRealOff, turnRealOn } from '@/lib/actions/real'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getRealPanel } from '@/lib/queries/real'
import { archiveStrayActive, dropSessions, holdActiveSessions, seedRealSession, testSessionId, type TestDb } from '../db'
import { position } from '../fixtures'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())
vi.mock('@/lib/session', () => ({ requireSession: vi.fn(async () => ({ user: { email: 'owner@example.com' } })) }))
vi.mock('next/cache', () => ({ refresh: vi.fn() }))

// Crea sesiones activas y escribe los chequeos (una sola tabla para toda la base): se turna
// con los otros archivos que crean activas.
const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const created: string[] = []
let release: () => Promise<void>

const allOk = (): RealCheck[] => REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '' }))

async function readiness({
  env = 'testnet',
  checks = allOk(),
  minutesAgo = 0,
  walletAvailable = 120,
}: { env?: BinanceEnv; checks?: RealCheck[]; minutesAgo?: number; walletAvailable?: number | null } = {}) {
  await t.repos.realReadiness.upsert({ env, enabled: true, keysPresent: true, checks, walletAvailable, instanceId: 'mac-1' })
  if (minutesAgo > 0) await t.db.update(realReadiness).set({ checkedAt: sql`now() - ${`${minutesAgo} minutes`}::interval` })
}

async function realOf(id: string) {
  return t.repos.sessions.get(id)
}

beforeAll(async () => {
  release = await holdActiveSessions(t)
})

beforeEach(async () => {
  await archiveStrayActive(t)
  await t.db.delete(realReadiness)
})

afterAll(async () => {
  const active = await t.repos.sessions.getActive('live')
  if (active) created.push(active.id)
  await dropSessions(t, created)
  await t.db.delete(realReadiness)
  await release()
  await t.db.$client.end()
})

async function create(input: { capital: number; lossCap: number; confirmation: string }) {
  const result = await createRealSession(input)
  if (result.ok) created.push(result.sessionId)
  return result
}

describe('createRealSession', () => {
  it('no crea sin readiness fresca', async () => {
    expect(await create({ capital: 50, lossCap: 0.5, confirmation: '50' })).toMatchObject({ ok: false, reason: 'not_ready' })
    await readiness({ minutesAgo: 20 })
    const stale = await create({ capital: 50, lossCap: 0.5, confirmation: '50' })
    expect(stale).toMatchObject({ ok: false, reason: 'not_ready' })
    expect(stale.ok ? '' : stale.message).toContain('más de 15 minutos')
    expect(await t.repos.sessions.getActive('live')).toBeNull()
  })

  it('no crea con un chequeo en rojo', async () => {
    await readiness({ checks: allOk().map((c) => (c.id === 'one_way' ? { ...c, status: 'fail' } : c)) })
    const result = await create({ capital: 50, lossCap: 0.5, confirmation: '50' })
    expect(result).toEqual({ ok: false, reason: 'not_ready', message: 'Todavía no se puede. Falta: La cuenta está en modo de una posición por moneda.' })
  })

  it('no crea si la confirmación no es el monto', async () => {
    await readiness()
    expect(await create({ capital: 50, lossCap: 0.5, confirmation: '40' })).toEqual({
      ok: false,
      reason: 'confirmation',
      message: 'Escribí 50 para confirmar: es el capital que vas a usar.',
    })
    expect(await t.repos.sessions.getActive('live')).toBeNull()
  })

  it('rechaza un capital o un tope fuera de rango', async () => {
    await readiness()
    expect(await create({ capital: 4, lossCap: 0.5, confirmation: '4' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await create({ capital: 50, lossCap: 0.05, confirmation: '50' })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('no crea con más capital que el disponible en la billetera', async () => {
    await readiness()
    const result = await create({ capital: 500, lossCap: 0.5, confirmation: '500' })
    expect(result).toMatchObject({ ok: false, reason: 'not_ready' })
  })

  it('no crea si el bot no pudo leer la billetera de futuros', async () => {
    await readiness({ walletAvailable: null })
    expect(await create({ capital: 50, lossCap: 0.5, confirmation: '50' })).toEqual({
      ok: false,
      reason: 'not_ready',
      message: 'Todavía no se puede. Falta: Que el bot lea la billetera de futuros.',
    })
    expect(await t.repos.sessions.getActive('live')).toBeNull()
  })

  it('crea con el entorno de la readiness', async () => {
    await readiness({ env: 'mainnet' })
    const result = await create({ capital: 50, lossCap: 0.4, confirmation: '50' })
    if (!result.ok) throw new Error(result.message)
    expect(await realOf(result.sessionId)).toMatchObject({ kind: 'live', status: 'active', binanceEnv: 'mainnet', realStatus: 'on', capitalInicial: 50 })
    expect((await t.repos.settings.get(result.sessionId))?.config.risk.lossCap).toBe(0.4)
  })

  it('archiva en el acto una real apagada sin abiertas y no toca una prendida', async () => {
    await readiness()
    const on = await seedRealSession(t, testSessionId('real-on'))
    created.push(on)
    expect(await create({ capital: 50, lossCap: 0.5, confirmation: '50' })).toMatchObject({ ok: false, reason: 'not_ready' })
    expect((await realOf(on))?.status).toBe('active')

    await t.repos.sessions.setRealStatus(on, 'loss_floor', null)
    const result = await create({ capital: 30, lossCap: 0.5, confirmation: '30' })
    if (!result.ok) throw new Error(result.message)
    expect((await realOf(on))?.status).toBe('archived')
    expect((await realOf(result.sessionId))?.capitalInicial).toBe(30)
  })
})

describe('prender y apagar', () => {
  it('apagar la deja apagada en el acto y le pide al bot cerrar todo', async () => {
    const id = await seedRealSession(t, testSessionId('real-off'))
    created.push(id)
    const commandId = crypto.randomUUID()
    expect(await turnRealOff({ id: commandId, sessionId: id })).toEqual({ ok: true, id: commandId, duplicate: false })
    expect(await realOf(id)).toMatchObject({ realStatus: 'off', realOffReason: 'user' })
    expect((await t.repos.commands.listRecent(id))[0]).toMatchObject({ id: commandId, kind: 'real_off', status: 'pending' })
  })

  it('después del tope, apagar sigue apagada por el tope y le pide al bot cerrar lo que quede', async () => {
    const id = await seedRealSession(t, testSessionId('real-off-floor'), { realStatus: 'loss_floor' })
    created.push(id)
    const commandId = crypto.randomUUID()
    expect(await turnRealOff({ id: commandId, sessionId: id })).toEqual({ ok: true, id: commandId, duplicate: false })
    expect((await realOf(id))?.realStatus).toBe('loss_floor')
    expect((await t.repos.commands.listRecent(id))[0]).toMatchObject({ id: commandId, kind: 'real_off' })
  })

  it('si la archivaron entre la lectura y la escritura, no encola nada', async () => {
    const id = await seedRealSession(t, testSessionId('real-off-archived'), { realStatus: 'off' })
    created.push(id)
    const active = await realOf(id)
    if (!active) throw new Error('falta la sesión')
    expect(await t.repos.sessions.archiveReal(id)).toEqual({ archived: true })
    // La lectura de afuera todavía la ve activa; la escritura ya no.
    vi.spyOn(appRepos.sessions, 'get').mockResolvedValueOnce(active)
    expect(await turnRealOff({ id: crypto.randomUUID(), sessionId: id })).toMatchObject({ ok: false, reason: 'not_active' })
    expect(await t.repos.commands.listRecent(id)).toEqual([])
  })

  it('apagar una simulación en papel no hace nada', async () => {
    const paper = await t.repos.sessions.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    created.push(paper.id)
    expect(await turnRealOff({ id: crypto.randomUUID(), sessionId: paper.id })).toMatchObject({ ok: false, reason: 'not_active' })
  })

  it('prender pide el monto y los chequeos en verde', async () => {
    const id = await seedRealSession(t, testSessionId('real-on-again'), { realStatus: 'off' })
    created.push(id)
    expect(await turnRealOn({ sessionId: id, confirmation: '50' })).toMatchObject({ ok: false, reason: 'not_ready' })
    await readiness()
    expect(await turnRealOn({ sessionId: id, confirmation: '5' })).toMatchObject({ ok: false, reason: 'confirmation' })
    expect(await turnRealOn({ sessionId: id, confirmation: '50' })).toEqual({ ok: true })
    expect((await realOf(id))?.realStatus).toBe('on')
  })

  it('no se puede prender después del tope', async () => {
    await readiness()
    const id = await seedRealSession(t, testSessionId('real-floor'), { realStatus: 'loss_floor' })
    created.push(id)
    expect(await turnRealOn({ sessionId: id, confirmation: '50' })).toEqual({
      ok: false,
      reason: 'loss_floor',
      message: 'Apagada por el tope de pérdida. Para seguir, empezá una sesión nueva con un capital nuevo.',
    })
    expect((await realOf(id))?.realStatus).toBe('loss_floor')
  })
})

describe('el panel de Ajustes › Plata real', () => {
  it('una real apagada con abiertas dice que hay que esperar a que se cierren', async () => {
    await readiness()
    const id = await seedRealSession(t, testSessionId('real-panel-open'), { realStatus: 'off' })
    created.push(id)
    await t.repos.positions.upsertOpen(id, position('real-panel-open-1'))
    const panel = await getRealPanel()
    expect(panel.session).toMatchObject({ id, status: 'off', openPositions: 1 })
    expect(panel.canCreate).toEqual({ ok: false, missing: ['Que se cierren las posiciones abiertas de la sesión con plata real anterior'] })
  })
})
