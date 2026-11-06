// @vitest-environment node
import { count, eq, getTableName, is, isNotNull, isNull } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import * as schema from '@sereno/db'
import { account, botStatus, candles, decisions, equitySnapshots, marketSnapshot, positions, sessions, session, settingsHistory, symbols, user, verification, type DirectDb } from '@sereno/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDataset } from '../../scripts/demo/scenario'
import { DATA_TABLES, writeDataset } from '../../scripts/demo/write'
import { assertWebTestUrl, openTestDb, TEST_URL } from './db'

const NOW = Date.parse('2026-10-31T23:41:12Z')
const options = { seed: 20261031, now: NOW, ownerEmail: 'toti@example.com' }

describe('base de los tests de web', () => {
  it('es una *_test distinta de la de @sereno/db', () => {
    const local = 'postgresql://postgres@127.0.0.1:5499'
    expect(() => assertWebTestUrl(`${local}/sereno_web_test`, `${local}/sereno_test`)).not.toThrow()
    expect(() => assertWebTestUrl(`${local}/sereno_test`, `${local}/sereno_test`)).toThrow(/@sereno\/db/)
    expect(() => assertWebTestUrl(`${local}/sereno`, `${local}/sereno_test`)).toThrow(/_test/)
  })
})

describe('tablas que borra un escenario', () => {
  // Las de Better Auth se conservan: el usuario de `seed:user` sobrevive a cada escenario.
  const AUTH_TABLES = new Set<string>([user, session, account, verification].map((t) => getTableName(t)))

  it('son todas las del esquema de @sereno/db menos las de Better Auth', () => {
    const exported: unknown[] = Object.values(schema)
    const schemaTables = exported
      .filter((value): value is PgTable => is(value, PgTable))
      .map((t) => getTableName(t))
      .filter((name) => !AUTH_TABLES.has(name))
    const wiped: string[] = DATA_TABLES.map((t) => getTableName(t))
    const missing = schemaTables.filter((name) => !wiped.includes(name))
    expect(missing, `Faltan en DATA_TABLES (scripts/demo/write.ts): ${missing.join(', ')}`).toEqual([])
    expect(wiped.filter((name) => AUTH_TABLES.has(name)), 'DATA_TABLES no puede borrar tablas de Better Auth').toEqual([])
    expect(new Set(wiped).size).toBe(wiped.length)
  })
})

describe.skipIf(TEST_URL === undefined)('writeDataset (Postgres)', () => {
  let db: DirectDb

  beforeAll(async () => {
    db = await openTestDb()
  })

  afterAll(async () => {
    await db?.$client.end()
  })

  const total = async (table: PgTable): Promise<number> => {
    const [row] = await db.select({ n: count() }).from(table)
    return row?.n ?? 0
  }

  it('vuelca el escenario completo y conserva al usuario del dashboard', async () => {
    await db.delete(user).where(eq(user.id, 'usr_demo_test'))
    await db.insert(user).values({ id: 'usr_demo_test', name: 'Toti', email: 'demo-test@example.com', emailVerified: true, createdAt: new Date(NOW), updatedAt: new Date(NOW) })

    const dataset = buildDataset('replays', options)
    const written = await writeDataset(db, dataset)
    const live = dataset.sessions[0]
    if (!live?.books) throw new Error('sin simulación en vivo')

    expect(await total(sessions)).toBe(4)
    expect(await total(symbols)).toBe(30)
    expect(await total(positions)).toBe(written.positions)
    expect(await total(decisions)).toBe(dataset.sessions.reduce((n, s) => n + s.decisions.length, 0))
    const withForward = dataset.sessions.reduce((n, s) => n + [...s.forwardReturns.values()].filter((fr) => fr.forwardReturn24h !== undefined).length, 0)
    const [filled] = await db.select({ n: count() }).from(decisions).where(isNotNull(decisions.forwardReturn24h))
    expect(withForward).toBeGreaterThan(0)
    expect(filled?.n).toBe(withForward)
    expect(await total(equitySnapshots)).toBe(written.equityPoints)
    expect(await total(candles)).toBe(written.candles)

    const open = await db.select({ n: count() }).from(positions).where(isNull(positions.closedAt))
    expect(open[0]?.n).toBe(3 + 3 + 2 + 2)
    const [status] = await db.select().from(botStatus)
    expect(status?.lastHeartbeat.getTime()).toBe(NOW - 5_000)
    const [snapshot] = await db.select().from(marketSnapshot)
    expect(snapshot?.symbols).toHaveLength(30)
    const history = await db.select().from(settingsHistory).where(eq(settingsHistory.sessionId, live.row.id ?? ''))
    expect(history).toHaveLength(live.settings.length)
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, live.row.id ?? ''))
    expect(stored?.startedAt.getTime()).toBe((live.row.startedAt as Date).getTime())

    const [kept] = await db.select().from(user).where(eq(user.id, 'usr_demo_test'))
    expect(kept?.email).toBe('demo-test@example.com')
  }, 120_000)

  it('otro escenario reemplaza al anterior sin dejar restos', async () => {
    await writeDataset(db, buildDataset('first-run', options))
    expect(await total(sessions)).toBe(0)
    expect(await total(positions)).toBe(0)
    expect(await total(candles)).toBe(0)
    const [kept] = await db.select().from(user).where(eq(user.id, 'usr_demo_test'))
    expect(kept).toBeDefined()
    await db.delete(user).where(eq(user.id, 'usr_demo_test'))
  }, 60_000)
})
