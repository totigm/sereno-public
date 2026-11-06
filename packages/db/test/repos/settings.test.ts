import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { DirectDb } from '../../src/client'
import { createSettingsRepo } from '../../src/repos/settings'
import { sessions, settings, settingsHistory } from '../../src/schema'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_settings'
const RISK_2 = { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.02 }
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, settings, settingsHistory)
  await seedSession(db, SESSION)
  await createSettingsRepo(db).create(SESSION, DEFAULT_SETTINGS, { by: 'toti@example.com' })
})

describe('settingsRepo', () => {
  it('get devuelve config y versión 1 recién creada; null si la sesión no tiene settings', async () => {
    const repo = createSettingsRepo(db)
    const actual = await repo.get(SESSION)
    expect(actual?.version).toBe(1)
    expect(actual?.config).toEqual(DEFAULT_SETTINGS)
    expect(actual?.updatedBy).toBe('toti@example.com')
    expect(await repo.get('ses_inexistente')).toBeNull()
  })

  it('update con la versión vigente aplica el parche y sube la versión', async () => {
    const repo = createSettingsRepo(db)
    expect(await repo.update(SESSION, { risk: RISK_2 }, 1, { by: 'toti@example.com' })).toEqual({ ok: true, version: 2 })
    const actual = await repo.get(SESSION)
    expect(actual?.version).toBe(2)
    expect(actual?.config.risk.riskPerTrade).toBe(0.02)
    // El resto de la configuración sigue intacto.
    expect(actual?.config.exits).toEqual(DEFAULT_SETTINGS.exits)
  })

  it('update con una versión vieja devuelve ok: false con la versión vigente y no escribe', async () => {
    const repo = createSettingsRepo(db)
    await repo.update(SESSION, { risk: RISK_2 }, 1)
    const res = await repo.update(SESSION, { risk: { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.03 } }, 1)
    expect(res).toEqual({ ok: false, version: 2 })
    expect((await repo.get(SESSION))?.config.risk.riskPerTrade).toBe(0.02)
    expect((await repo.history(SESSION)).map((h) => h.version)).toEqual([2, 1])
  })

  it('dos updates en paralelo con la misma versión: gana uno solo', async () => {
    const otra = await openTestDb(1)
    try {
      const [a, b] = await Promise.all([
        createSettingsRepo(db).update(SESSION, { mode: 'custom' }, 1),
        createSettingsRepo(otra).update(SESSION, { risk: RISK_2 }, 1),
      ])
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
      expect([a.version, b.version]).toEqual([2, 2])
      const actual = await createSettingsRepo(db).get(SESSION)
      expect(actual?.version).toBe(2)
      // Se aplicó entero uno de los dos parches, nunca una mezcla.
      const custom = actual?.config.mode === 'custom'
      const riesgo = actual?.config.risk.riskPerTrade === 0.02
      expect(custom !== riesgo).toBe(true)
    } finally {
      await otra.$client.end()
    }
  })

  it('update sobre una sesión sin settings devuelve ok: false, version: null', async () => {
    await seedSession(db, 'ses_sin_settings')
    expect(await createSettingsRepo(db).update('ses_sin_settings', { mode: 'custom' }, 1)).toEqual({
      ok: false,
      version: null,
    })
  })

  it('rechaza un parche inválido sin tocar la base', async () => {
    const repo = createSettingsRepo(db)
    await expect(repo.update(SESSION, { risk: { ...DEFAULT_SETTINGS.risk, riskPerTrade: 0.5 } }, 1)).rejects.toThrow()
    expect((await repo.get(SESSION))?.version).toBe(1)
    expect(await repo.history(SESSION)).toHaveLength(1)
  })

  it('history guarda cada versión con quién y cuándo, la más nueva primero', async () => {
    const repo = createSettingsRepo(db)
    await repo.update(SESSION, { mode: 'custom' }, 1, { by: 'toti@example.com' })
    // El bot pausa solo: sin email.
    await repo.update(SESSION, { pause: { paused: true, by: 'auto', at: '2026-10-31T12:00:00.000Z', reason: 'drawdown' } }, 2)
    const h = await repo.history(SESSION)
    expect(h.map((x) => x.version)).toEqual([3, 2, 1])
    expect(h[0]?.changedBy).toBeNull()
    expect(h[0]?.config.pause.paused).toBe(true)
    expect(h[0]?.config.mode).toBe('custom')
    expect(h[1]?.changedBy).toBe('toti@example.com')
    expect(h[2]?.config).toEqual(DEFAULT_SETTINGS)
    expect(h[0]?.changedAt).toBeInstanceOf(Date)
    expect((await repo.history(SESSION, 1)).map((x) => x.version)).toEqual([3])
    expect((await repo.get(SESSION))?.updatedBy).toBeNull()
  })

  it('historyBetween trae sólo las versiones estrictamente entre dos, de la más vieja a la más nueva', async () => {
    const repo = createSettingsRepo(db)
    for (let version = 1; version <= 4; version++) await repo.update(SESSION, { mode: version % 2 === 0 ? 'auto' : 'custom' }, version)
    expect((await repo.historyBetween(SESSION, 1, 4)).map((x) => x.version)).toEqual([2, 3])
    // Aunque haya versiones más nuevas que `before` (otro guardó en el medio), la ventana no se corre.
    expect((await repo.historyBetween(SESSION, 2, 4)).map((x) => x.version)).toEqual([3])
    expect(await repo.historyBetween(SESSION, 3, 4)).toEqual([])
  })
})
