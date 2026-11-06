import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { DirectDb } from '../../src/client'
import { createRepos } from '../../src/repos'
import { createUniverseDaysRepo, type UniverseDay } from '../../src/repos/universe-days'
import { sessions, type UniverseDayEntry } from '../../src/schema'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_universe'
const OTHER = 'ses_universe_otra'
const FILTERS = { minNotional: 5, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, quantityPrecision: 3, liquidationFee: 0.0125 }

const entry = (symbol: string, rank: number, extra: Partial<UniverseDayEntry> = {}): UniverseDayEntry => ({
  symbol,
  rank,
  quoteVolume24h: 1_000_000 / rank,
  pinned: false,
  filters: FILTERS,
  ...extra,
})

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions)
  await seedSession(db, SESSION)
  await seedSession(db, OTHER)
})

describe('universeDays', () => {
  it('guarda el día con las anotaciones de cada moneda y las que quedaron afuera, con su motivo', async () => {
    const repo = createUniverseDaysRepo(db)
    const day: UniverseDay = {
      day: '2026-10-31',
      symbols: [entry('BTCUSDT', 1), entry('OLDUSDT', 2, { keptOpen: 'status' }), entry('GONEUSDT', 3, { delisted: true })],
      excluded: {
        XAUUSDT: { reason: 'tradfi' },
        NEWUSDT: { reason: 'history', detail: '2026-10-20', pinned: true },
      },
    }
    await repo.upsertDay(SESSION, day)
    expect(await repo.forDay(SESSION, '2026-10-31')).toEqual(day)
    expect(await repo.forDay(SESSION, '2026-10-30')).toBeNull()
    expect(await repo.forDay(OTHER, '2026-10-31')).toBeNull()
  })

  it('recalcular el mismo día reemplaza monedas y excluidas', async () => {
    const repo = createUniverseDaysRepo(db)
    await repo.upsertDay(SESSION, { day: '2026-10-31', symbols: [entry('BTCUSDT', 1)], excluded: { XAUUSDT: { reason: 'tradfi' } } })
    await repo.upsertDay(SESSION, { day: '2026-10-31', symbols: [entry('ETHUSDT', 1)], excluded: {} })
    expect(await repo.forDay(SESSION, '2026-10-31')).toEqual({ day: '2026-10-31', symbols: [entry('ETHUSDT', 1)], excluded: {} })
  })

  it('upsertDays guarda varios días de una vez (los de un replay) y reemplaza los que ya estaban', async () => {
    const repo = createUniverseDaysRepo(db)
    await repo.upsertDay(SESSION, { day: '2026-10-29', symbols: [entry('BTCUSDT', 1)], excluded: {} })
    const days: UniverseDay[] = [
      { day: '2026-10-29', symbols: [entry('ETHUSDT', 1)], excluded: { XAUUSDT: { reason: 'tradfi' } } },
      { day: '2026-10-30', symbols: [entry('SOLUSDT', 1), entry('BTCUSDT', 2, { keptOpen: 'status' })], excluded: {} },
    ]
    await repo.upsertDays(SESSION, days)
    await repo.upsertDays(SESSION, [])
    expect(await repo.forDay(SESSION, '2026-10-29')).toEqual(days[0])
    expect(await repo.forDay(SESSION, '2026-10-30')).toEqual(days[1])
    expect(await repo.forDay(OTHER, '2026-10-30')).toBeNull()
  })

  it('latest devuelve el día más reciente de la sesión, o null si no tiene ninguno', async () => {
    const repo = createUniverseDaysRepo(db)
    expect(await repo.latest(SESSION)).toBeNull()
    await repo.upsertDay(SESSION, { day: '2026-10-31', symbols: [entry('BTCUSDT', 1)], excluded: {} })
    await repo.upsertDay(SESSION, { day: '2026-10-29', symbols: [entry('SOLUSDT', 1)], excluded: {} })
    await repo.upsertDay(OTHER, { day: '2026-11-01', symbols: [entry('ETHUSDT', 1)], excluded: {} })
    expect((await repo.latest(SESSION))?.day).toBe('2026-10-31')
  })

  it('una fila anterior a la columna `excluded` se lee sin excluidas', async () => {
    await db.execute(sql`insert into universe_days (session_id, day, symbols) values (${SESSION}, '2026-10-30', '[]'::jsonb)`)
    expect(await createUniverseDaysRepo(db).forDay(SESSION, '2026-10-30')).toEqual({ day: '2026-10-30', symbols: [], excluded: {} })
  })

  it('está entre los repos de createRepos', async () => {
    const repos = createRepos(db)
    await repos.universeDays.upsertDay(SESSION, { day: '2026-10-31', symbols: [], excluded: {} })
    expect(await repos.universeDays.latest(SESSION)).toEqual({ day: '2026-10-31', symbols: [], excluded: {} })
  })
})
