import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DirectDb } from '../../src/client'
import { createEquityRepo, type EquityPoint } from '../../src/repos/equity'
import { equitySnapshots, sessions } from '../../src/schema'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_eq'
const REPLAY = 'ses_eq_replay'
const M = 60_000
const T = Date.parse('2026-10-31T00:00:00Z')
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, equitySnapshots)
  await seedSession(db, SESSION)
  await seedSession(db, REPLAY, { kind: 'replay', status: 'en_cola' })
})

function point(at: number, equity: number, kind: EquityPoint['kind'] = 'minute'): EquityPoint {
  return {
    at,
    saldo: 1000,
    equity,
    margenEnUso: 50,
    protegido: 0,
    capitalBase: 1000,
    capitalOperable: 950,
    shadowEquity: 1001.5,
    kind,
  }
}

describe('equityRepo', () => {
  it('series devuelve la curva en [from, to) en orden, con o sin filtro de tipo', async () => {
    const repo = createEquityRepo(db)
    await repo.insert(SESSION, [point(T + 2 * M, 1002), point(T, 1000), point(T + M, 1001, 'event')])
    await repo.insert(SESSION, point(T + 3 * M, 1003))
    expect((await repo.series(SESSION, T, T + 3 * M)).map((p) => p.equity)).toEqual([1000, 1001, 1002])
    expect((await repo.series(SESSION, T, T + 10 * M, 'event')).map((p) => p.at)).toEqual([T + M])
    const [primero] = await repo.series(SESSION, T, T + M)
    expect(primero).toMatchObject({ ...point(T, 1000), sessionId: SESSION })
  })

  it('peak es el máximo de la equity en [from, to); null sin puntos', async () => {
    const repo = createEquityRepo(db)
    expect(await repo.peak(SESSION, T, T + 10 * M)).toBeNull()
    await repo.insert(SESSION, [point(T, 1000), point(T + M, 1300, 'event'), point(T + 2 * M, 1100), point(T + 3 * M, 1200)])
    await repo.insert(REPLAY, [point(T + M, 5000)])
    expect(await repo.peak(SESSION, T, T + 10 * M)).toBe(1300)
    expect(await repo.peak(SESSION, T + 2 * M, T + 10 * M)).toBe(1200)
    expect(await repo.peak(SESSION, T, T + M)).toBe(1000)
  })

  it('drawdownHit mira la caída de cada punto desde el pico corrido, que arranca en el pico anterior', async () => {
    const repo = createEquityRepo(db)
    // 1.000 → 1.300 → 1.100: una caída del 15,38% desde 1.300.
    await repo.insert(SESSION, [point(T, 1000), point(T + M, 1300), point(T + 2 * M, 1100), point(T + 3 * M, 1250)])
    const hit = (from: number, to: number, priorPeak: number | null, maxDrawdown: number) => repo.drawdownHit(SESSION, { from, to, priorPeak, maxDrawdown })
    expect(await hit(T, T + 10 * M, null, 0.15)).toBe(true)
    expect(await hit(T, T + 10 * M, null, 0.16)).toBe(false)
    // Sin el 1.300 en la ventana, 1.100 no cae un 15% desde 1.000… salvo que el pico anterior fuera 1.300.
    expect(await hit(T + 2 * M, T + 10 * M, null, 0.15)).toBe(false)
    expect(await hit(T + 2 * M, T + 10 * M, 1300, 0.15)).toBe(true)
    // El orden importa: 1.000 antes de 1.300 no es una caída.
    expect(await hit(T, T + 2 * M, null, 0.01)).toBe(false)
    expect(await hit(T, T + 10 * M, null, 1)).toBe(false)
  })

  it('latest es el punto más reciente de la sesión; null si no hay', async () => {
    const repo = createEquityRepo(db)
    expect(await repo.latest(SESSION)).toBeNull()
    await repo.insert(SESSION, [point(T, 1000), point(T + 5 * M, 1005)])
    await repo.insert(REPLAY, [point(T + 9 * M, 1)])
    expect((await repo.latest(SESSION))?.equity).toBe(1005)
  })

  it('pruneMinuteOlderThan borra sólo los por minuto viejos de las sesiones en vivo', async () => {
    const repo = createEquityRepo(db)
    await repo.insert(SESSION, [point(T, 1000), point(T, 999, 'event'), point(T + 10 * M, 1010)])
    await repo.insert(REPLAY, [point(T, 1000)])
    expect(await repo.pruneMinuteOlderThan(T + M)).toBe(1)
    expect((await repo.series(SESSION, 0, T + 20 * M)).map((p) => [p.kind, p.equity])).toEqual([
      ['event', 999],
      ['minute', 1010],
    ])
    expect(await repo.series(REPLAY, 0, T + 20 * M)).toHaveLength(1)
  })
})
