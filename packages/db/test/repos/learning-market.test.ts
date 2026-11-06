import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LearningState } from '@sereno/core'
import type { DirectDb } from '../../src/client'
import { createLearningRepo, type LearningLogEntry } from '../../src/repos/learning'
import { createMarketRepo } from '../../src/repos/market'
import { learningLog, learningState, marketSnapshot, sessions } from '../../src/schema'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_learn'
const T = Date.parse('2026-10-31T00:00:00Z')
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, learningState, learningLog, marketSnapshot)
  await seedSession(db, SESSION)
})

const ones = {
  trend15m: 1,
  trendHigher: 1,
  momentum: 1,
  breakout: 1,
  bands: 1,
  vwap: 1,
  funding: 1,
  openInterest: 1,
  positioning: 1,
  btcRegime: 1,
}

function state(closedTrades: number): LearningState {
  return {
    weightsGlobal: { ...ones, momentum: 0.8 },
    weightsBySymbol: { SOLUSDT: { momentum: 0.6 } },
    weeklyDelta: { ...ones, momentum: -0.2 },
    weekStart: Date.parse('2026-10-26T00:00:00Z'),
    confidenceBySymbol: { SOLUSDT: -0.1 },
    tradesBySymbol: { SOLUSDT: 9 },
    penalties: { DOGEUSDT: Date.parse('2026-11-07T00:00:00Z') },
    params: { theta: 0.4, k: 1.5, tpR: 2, trailingR: 1, since: Date.parse('2026-10-20T00:00:00Z') },
    frozen: false,
    closedTrades,
    version: closedTrades,
  }
}

function cambio(at: number, message: string): LearningLogEntry {
  return { at, kind: 'weight_trade', symbol: 'SOLUSDT', signal: 'momentum', message, sampleSize: 14, before: 1, after: 0.8 }
}

describe('learningRepo', () => {
  it('get es null sin estado; save guarda y reescribe el estado completo', async () => {
    const repo = createLearningRepo(db)
    expect(await repo.get(SESSION)).toBeNull()
    await repo.save(SESSION, state(50))
    expect(await repo.get(SESSION)).toEqual(state(50))
    await repo.save(SESSION, { ...state(51), frozen: true })
    expect(await repo.get(SESSION)).toEqual({ ...state(51), frozen: true })
  })

  it('el diario se lee de lo más nuevo a lo más viejo y pagina sin perder un lote con el mismo instante', async () => {
    const repo = createLearningRepo(db)
    await repo.appendLog(SESSION, cambio(T, 'primero'))
    await repo.appendLog(SESSION, [cambio(T + 1000, 'lote a'), cambio(T + 1000, 'lote b'), cambio(T + 1000, 'lote c')])
    const pagina1 = await repo.listLog(SESSION, { limit: 2 })
    expect(pagina1.map((e) => e.message)).toEqual(['lote c', 'lote b'])
    const ultimo = pagina1[1]
    if (!ultimo) throw new Error('falta la página')
    const pagina2 = await repo.listLog(SESSION, { limit: 2, cursor: { at: ultimo.at, id: ultimo.id } })
    expect(pagina2.map((e) => e.message)).toEqual(['lote a', 'primero'])
    expect(pagina2[1]).toMatchObject({ ...cambio(T, 'primero'), sessionId: SESSION })
  })
})

describe('marketRepo', () => {
  it('upsert mantiene una sola fila por sesión y sube la versión en cada escritura', async () => {
    const repo = createMarketRepo(db)
    expect(await repo.get(SESSION)).toBeNull()
    const sol = { symbol: 'SOLUSDT', markPrice: 130, change24h: 0.02, sPrime: 0.3, lean: 0.3, state: 'ready' } as const
    expect(await repo.upsert(SESSION, [sol])).toBe(1)
    expect(await repo.upsert(SESSION, [{ ...sol, markPrice: 131 }])).toBe(2)
    const fila = await repo.get(SESSION)
    expect(fila).toMatchObject({ version: 2, symbols: [{ ...sol, markPrice: 131 }] })
    expect(await db.select().from(marketSnapshot)).toHaveLength(1)
  })
})
