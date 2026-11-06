// @vitest-environment node
import type { DirectDb } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getResumenData } from '@/lib/queries/resumen'
import { dropSessions, seedSession, testSessionId, type TestDb } from '../db'
import { replayReport } from './fixtures'

// Resumen lee el reporte que el bot dejó al terminar un replay (`sessions.report`, spec §9).

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const SIMULATION = testSessionId('resumen_reporte')
let replayId = ''

beforeAll(async () => {
  await seedSession(t, SIMULATION)
  const replay = await t.repos.sessions.createReplay({
    name: 'Replay · 90 días',
    capitalInicial: 1000,
    settings: DEFAULT_SETTINGS,
    learningOrigin: 'zero',
    replayParams: { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: false },
  })
  replayId = replay.id
  await t.repos.sessions.completeReplay(replayId, { report: replayReport(), mensaje: 'Con 21 operaciones todavía no se puede saber si tiene ventaja.' })
})

afterAll(async () => {
  await dropSessions(t, [SIMULATION, replayId])
})

describe('getResumenData, el reporte del replay', () => {
  it('trae lo que el bot dejó, listo para mostrar, con el umbral de su aprendizaje', async () => {
    const report = (await getResumenData(replayId))?.report
    expect(report?.fortnights.map((f) => f.trades)).toEqual([12, 9])
    expect(report?.missingSignals.map((m) => m.signal)).toEqual(['funding', 'openInterest', 'positioning'])
    expect(report?.pairs[0]).toMatchObject({ a: 'trend15m', b: 'trendHigher', rho: 0.82 })
    expect(report?.universe.changes).toHaveLength(1)
    expect(report?.theta).toBeGreaterThan(0)
  })

  it('una simulación no tiene reporte de replay', async () => {
    expect((await getResumenData(SIMULATION))?.report).toBeNull()
  })
})
