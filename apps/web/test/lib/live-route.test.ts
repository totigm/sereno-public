// @vitest-environment node
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { botCommands, botStatus, type DirectDb, type MarketSymbolView } from '@sereno/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/live/route'
import { db as appDb, repos as appRepos } from '@/lib/db'
import type { LivePayload, LiveResponse } from '@/lib/live/types'
import { requireApiSession } from '@/lib/session'
import { dropSessions, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'
import { closedPosition, position } from '../fixtures'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())
vi.mock('@/lib/session', () => ({
  requireApiSession: vi.fn(async () => ({ user: { email: 'owner@example.com' } })),
}))

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const SESSION = testSessionId('live')

const SYMBOLS: MarketSymbolView[] = [
  { symbol: 'SOLUSDT', markPrice: 127.5, change24h: 0.021, sPrime: 0.42, lean: 0.42, state: 'in_position' },
  { symbol: 'ETHUSDT', markPrice: 2600, change24h: -0.004, sPrime: -0.1, lean: -0.1, state: 'ready' },
]

async function get(query: string): Promise<{ status: number; body: LiveResponse }> {
  const response = await GET(new NextRequest(`http://localhost/api/live?${query}`))
  return { status: response.status, body: (await response.json()) as LiveResponse }
}

async function payload(query: string): Promise<LivePayload> {
  const { status, body } = await get(query)
  expect(status).toBe(200)
  if ('unchanged' in body) throw new Error('se esperaba el payload completo')
  return body
}

beforeAll(async () => {
  // El endpoint no mira el estado de la sesión y los tests le siguen escribiendo
  // (stops que se mueven): se queda en un estado escribible que no es `active`, para no
  // chocar con el índice de una sola activa mientras otros archivos corren en paralelo.
  await seedSession(t, SESSION, { status: SEEDING_STATUS })
  await t.repos.market.upsert(SESSION, SYMBOLS)
  await t.repos.bot.heartbeat({
    sessionId: SESSION,
    instanceId: 'mac-1',
    phase: 'live',
    warmProgress: 30,
    universeSize: 30,
    lastCycleAt: new Date(),
    settingsVersionApplied: 1,
    degradedSymbols: [],
    flags: { btcVolExtreme: false, dailyLossHit: false, drawdownPause: false, streakPause: false, learningFrozen: false },
    recentErrors: [],
    botVersion: '0.0.0',
  })
  await t.repos.positions.upsertOpen(SESSION, position('live-open', { feesPaid: 0.125, fundingPaid: 0.375 }))
  await t.repos.positions.close(SESSION, closedPosition('live-won', { pnlNet: 30 }), 'Cerré el long en SOL en el take profit.')
  await t.repos.positions.close(SESSION, closedPosition('live-lost', { pnlNet: -12.5, closeReason: 'stop' }), 'Cerré el long en SOL en el stop.')
  await t.repos.positions.upsertOpen(SESSION, position('live-shadow', { shadow: true }))
  await t.repos.equity.insert(SESSION, {
    at: Date.now() - 60_000,
    saldo: 1017,
    equity: 1022,
    margenEnUso: 50,
    protegido: 0,
    capitalBase: 1017,
    capitalOperable: 967,
    shadowEquity: 1005,
    kind: 'minute',
  })
})

afterAll(async () => {
  await dropSessions(t, [SESSION])
  await t.db.$client.end()
})

describe('GET /api/live', () => {
  it('devuelve mercado, abiertas valuadas, latido, equity y el libro de la cartera real', async () => {
    const live = await payload(`session=${SESSION}`)
    expect(live.sessionId).toBe(SESSION)
    expect(live.offline).toBe(false)
    expect(live.market?.symbols).toHaveLength(2)
    expect(live.open.map((p) => p.id)).toEqual(['live-open'])
    expect(live.open[0]?.valuation).toEqual({ mark: 127.5, unrealized: 5, net: 4.5, r: 0.9, pctOfMargin: 0.09 })
    expect(live.botStatus?.phase).toBe('live')
    expect(live.equityLast?.equity).toBe(1022)
    expect(live.settingsVersion).toBe(1)
    expect(live.settings?.mode).toBe('auto')
    // saldo = 1.000 + 30 − 12,50 − (0,125 + 0,375) de la abierta.
    expect(live.ledger).toMatchObject({ capitalInicial: 1000, saldo: 1017, closedCount: 2, wonCount: 1 })
    expect(live.commands).toEqual([])
    // Una simulación en papel no tiene interruptor de plata real.
    expect(live.realStatus).toBeNull()
  })

  it('contesta { unchanged: true } cuando `since` es la versión vigente', async () => {
    const { version } = await payload(`session=${SESSION}`)
    const { status, body } = await get(`session=${SESSION}&since=${encodeURIComponent(version)}`)
    expect(status).toBe(200)
    expect(body).toEqual({ unchanged: true })
  })

  it('con precios nuevos la versión cambia y vuelve el payload completo', async () => {
    const before = await payload(`session=${SESSION}`)
    await t.repos.market.upsert(SESSION, SYMBOLS.map((s) => ({ ...s, markPrice: s.markPrice * 1.01 })))
    const after = await payload(`session=${SESSION}&since=${encodeURIComponent(before.version)}`)
    expect(after.version).not.toBe(before.version)
    expect(after.market?.version).toBe((before.market?.version ?? 0) + 1)
  })

  it('un stop movido cambia la versión aunque el mercado no cambie', async () => {
    const before = await payload(`session=${SESSION}`)
    await t.repos.positions.upsertOpen(SESSION, position('live-open', { feesPaid: 0.125, fundingPaid: 0.375, stopPrice: 125 }))
    const after = await payload(`session=${SESSION}&since=${encodeURIComponent(before.version)}`)
    expect(after.version).not.toBe(before.version)
    expect(after.open[0]?.stopPrice).toBe(125)
  })

  it('un comando nuevo cambia la versión y viaja en `commands`', async () => {
    const before = await payload(`session=${SESSION}`)
    const id = crypto.randomUUID()
    await t.repos.commands.enqueue({ id, sessionId: SESSION, kind: 'close_position', payload: { symbol: 'SOLUSDT' }, requestedBy: 'owner@example.com' })
    const after = await payload(`session=${SESSION}&since=${encodeURIComponent(before.version)}`)
    expect(after.commands.map((c) => [c.id, c.status, c.expired])).toEqual([[id, 'pending', false]])
  })

  it('un comando que vence por el reloj cambia la versión aunque el bot no lo marque', async () => {
    const id = crypto.randomUUID()
    await t.repos.commands.enqueue({ id, sessionId: SESSION, kind: 'close_position', payload: { symbol: 'SOLUSDT' }, requestedBy: 'owner@example.com' })
    const before = await payload(`session=${SESSION}`)
    expect(before.commands.find((c) => c.id === id)).toMatchObject({ status: 'pending', expired: false })
    // Sólo pasa el tiempo: nadie corre `expireStale` y la fila sigue `pending`.
    await t.db
      .update(botCommands)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(botCommands.id, id))
    const after = await payload(`session=${SESSION}&since=${encodeURIComponent(before.version)}`)
    expect(after.version).not.toBe(before.version)
    expect(after.commands.find((c) => c.id === id)).toMatchObject({ status: 'pending', expired: true })
  })

  it('con el latido de hace 61 s la versión cambia y el payload dice sin conexión', async () => {
    const before = await payload(`session=${SESSION}`)
    await t.db
      .update(botStatus)
      .set({ lastHeartbeat: sql`now() - interval '61 seconds'` })
      .where(eq(botStatus.sessionId, SESSION))
    const after = await payload(`session=${SESSION}&since=${encodeURIComponent(before.version)}`)
    expect(after.version).not.toBe(before.version)
    expect(after.offline).toBe(true)
  })

  it('404 con una sesión que no existe', async () => {
    const { status, body } = await get('session=ses_que_no_existe')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'no_session' })
  })

  it('sin sesión de usuario devuelve el 401 de requireApiSession, sin redirigir', async () => {
    vi.mocked(requireApiSession).mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }))
    const { status, body } = await get(`session=${SESSION}`)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'unauthorized' })
  })
})
