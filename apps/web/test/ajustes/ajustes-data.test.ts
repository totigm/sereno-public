import { eq } from 'drizzle-orm'
import { sessions, type DirectDb } from '@sereno/db'
import { ACCOUNT_TIERS_AUTHOR, DEFAULT_SETTINGS } from '@sereno/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db as appDb, repos as appRepos } from '@/lib/db'
import { getAjustesData } from '@/lib/queries/ajustes'
import { archiveSeeded, dropSessions, SEEDING_STATUS, seedSession, T0, testSessionId, type TestDb } from '../db'

vi.mock('@/lib/db', async () => (await import('../db')).openTestDb())

const t: TestDb = { db: appDb as DirectDb, repos: appRepos }
const SHIELDED = testSessionId('ajustes_shielded')
const PLAIN = testSessionId('ajustes_plain')
const TIERS = testSessionId('ajustes_tiers')
const ACCOUNT_RISK = { ...DEFAULT_SETTINGS.risk, mmrBySymbol: { BTCUSDT: 0.004, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }
const HOUR = 3_600_000

function point(at: number, protegido: number) {
  const equity = 1000 + (protegido > 0 ? 720 : 300)
  return { at, saldo: equity, equity, margenEnUso: 0, protegido, capitalBase: equity - protegido, capitalOperable: equity - protegido, shadowEquity: null, kind: 'event' as const }
}

beforeAll(async () => {
  await seedSession(t, SHIELDED, { status: SEEDING_STATUS })
  await seedSession(t, PLAIN)
  await seedSession(t, TIERS)
  await t.repos.settings.update(TIERS, { risk: ACCOUNT_RISK }, 1, { by: ACCOUNT_TIERS_AUTHOR })
  // Lo que Toti guarda después no es de la cuenta: el origen sale de la última versión del bot.
  await t.repos.settings.update(TIERS, { risk: { ...ACCOUNT_RISK, takerFeeRate: 0.0006 } }, 2, { by: 'owner@example.com' })
  await t.repos.equity.insert(SHIELDED, [point(T0 + HOUR, 0), point(T0 + 5 * HOUR, 1000), point(T0 + 6 * HOUR, 1000)])
  await t.db.update(sessions).set({ protegido: 1000 }).where(eq(sessions.id, SHIELDED))
  await archiveSeeded(t, SHIELDED)
})

afterAll(async () => {
  await dropSessions(t, [SHIELDED, PLAIN, TIERS])
  await t.db.$client.end()
})

describe('getAjustesData', () => {
  it('trae cuándo se blindó el capital vigente, para la frase "Blindaste … el 14 de octubre"', async () => {
    expect((await getAjustesData(SHIELDED))?.shieldedAt).toBe(T0 + 5 * HOUR)
  })

  it('sin blindaje no hay fecha', async () => {
    expect((await getAjustesData(PLAIN))?.shieldedAt).toBeNull()
  })

  it('trae el mmr y las comisiones de la última versión que guardó el bot con los datos de la cuenta', async () => {
    const saved = (await t.repos.settings.history(TIERS)).find((h) => h.version === 2)!
    expect((await getAjustesData(TIERS))?.accountTiers).toEqual({
      at: saved.changedAt.getTime(),
      mmrBySymbol: ACCOUNT_RISK.mmrBySymbol,
      takerFeeRate: 0.00045,
      makerFeeRate: 0.00018,
    })
  })

  it('sin versiones del bot no hay datos de la cuenta', async () => {
    expect((await getAjustesData(PLAIN))?.accountTiers).toBeNull()
  })
})
