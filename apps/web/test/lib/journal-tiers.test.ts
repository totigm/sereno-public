import { ACCOUNT_TIERS_AUTHOR, ACCOUNT_TIERS_PHRASE, DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadJournal } from '@/lib/queries/journal'
import { dropSessions, openTestDb, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'

const SESSION = testSessionId('journal_tiers')
let t: TestDb

beforeAll(async () => {
  t = await openTestDb()
  await seedSession(t, SESSION, { status: SEEDING_STATUS, startedAt: Date.now() - 3_600_000 })
  const risk = { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { BTCUSDT: 0.004, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }
  await t.repos.settings.update(SESSION, { risk }, 1, { by: ACCOUNT_TIERS_AUTHOR })
  // Un cambio de Toti en el riesgo no es una actualización de la cuenta.
  await t.repos.settings.update(SESSION, { risk: { ...risk, riskPerTrade: 0.02 } }, 2, { by: 'owner@example.com' })
})

afterAll(async () => {
  await dropSessions(t, [SESSION])
  await t.db.$client.end()
})

describe('diario: mmr y comisiones de la cuenta', () => {
  it('la versión que guardó el bot con los datos de la cuenta es una entrada del diario', async () => {
    const history = await t.repos.settings.history(SESSION)
    const saved = history.find((h) => h.version === 2)!
    const journal = await loadJournal(t.db, t.repos, { sessionId: SESSION, anchor: Date.now(), theta: 0.35, real: false })
    const tiers = journal.entries.filter((e) => e.kind === 'tiers')
    expect(tiers).toEqual([
      { id: 'tiers:2', at: saved.changedAt.getTime(), kind: 'tiers', text: ACCOUNT_TIERS_PHRASE, symbol: null, positionId: null, pnl: null, highlight: false, reported: false },
    ])
    expect(ACCOUNT_TIERS_PHRASE).toBe('Actualicé los márgenes de mantenimiento y las comisiones con los de tu cuenta de Binance.')
  })
})
