import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { NO_FLAGS } from '../../src/live/heartbeat'
import { loadRestoreInput } from '../../src/live/restore-load'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'
import { openPosition } from '../helpers/engine-fixtures'
import { backdate, equityAt, pauseAuto, setPause } from '../helpers/live'

// El pico del drawdown al retomar, leído de filas reales de `settings_history` y `equity_snapshots`.
const SESSION = 'ses_t20_restore_load'
const S = Date.UTC(2026, 8, 1, 0, 0, 0)
const H = 3_600_000

let t: TestDb
let session: SessionRow

beforeAll(async () => {
  t = await openTestDb()
})

afterAll(async () => {
  await t.query('delete from sessions where id = $1', [SESSION])
  await t.close()
})

beforeEach(async () => {
  await seedSession(t, SESSION, 'replay')
  await t.repos.settings.create(SESSION, DEFAULT_SETTINGS)
  session = (await t.repos.sessions.get(SESSION))!
})

async function restoreAt(now: number) {
  const row = (await t.repos.settings.get(SESSION))!
  return loadRestoreInput(t.repos, { session, settings: row.config, settingsVersion: row.version, lastFlags: NO_FLAGS, tickSize: () => 0.01, now })
}

describe('loadRestoreInput', () => {
  it('reanudar de una pausa propia no vuelve a medir el pico del drawdown', async () => {
    await t.repos.equity.insert(SESSION, [equityAt(S + H, 1_300), equityAt(S + 2 * H, 1_250), equityAt(S + 3 * H + 60_000, 1_240), equityAt(S + 4 * H, 1_245)])
    const paused = await setPause(t, SESSION, { paused: true, by: 'user', at: new Date(S + 2 * H).toISOString(), reason: null })
    const resumed = await setPause(t, SESSION, DEFAULT_SETTINGS.pause)
    await backdate(t, SESSION, S, { 1: S, [paused]: S + 2 * H + 60_000, [resumed]: S + 3 * H })

    expect((await restoreAt(S + 5 * H)).equityPeak).toBe(1_300)
  })

  it('levantar la pausa por drawdown vuelve a medir el pico desde la reanudación', async () => {
    await t.repos.equity.insert(SESSION, [equityAt(S + H, 1_300), equityAt(S + 2 * H, 1_100), equityAt(S + 3 * H + 60_000, 1_120), equityAt(S + 4 * H, 1_150)])
    const paused = await pauseAuto(t, SESSION, S + 2 * H, 'Me pausé solo: el capital cayó un 15,4% desde el pico.')
    const resumed = await setPause(t, SESSION, DEFAULT_SETTINGS.pause)
    await backdate(t, SESSION, S, { 1: S, [paused]: S + 2 * H + 1_000, [resumed]: S + 3 * H })

    const input = await restoreAt(S + 5 * H)
    expect(input.equityPeak).toBe(1_150)
    expect(input.lastFlags).toEqual(NO_FLAGS)
  })

  it('los costos previos de un cerrado que pasó la medianoche salen de sus eventos de apertura y funding', async () => {
    // S es medianoche UTC: 21:00 del día anterior en Buenos Aires.
    const overnight = openPosition({ id: 'rl-overnight', symbol: 'SOLUSDT', openedAt: S, feesPaid: 0.15 })
    const sameDay = openPosition({ id: 'rl-same-day', symbol: 'ETHUSDT', openedAt: S + 4 * H, feesPaid: 0.15 })
    const close = (p: typeof overnight, closedAt: number) =>
      t.repos.positions.close(SESSION, { ...p, feesPaid: 0.3, closedAt, exitPrice: 145, closeReason: 'stop', pnlGross: -9, pnlNet: -9.5, rMultiple: -0.95, costs: { fees: 0.3, spread: 0, slippage: 0, funding: 0.2 } }, 'Cerré.')
    for (const p of [overnight, sameDay]) {
      await t.repos.positions.upsertOpen(SESSION, p)
      await t.repos.positions.addEvent(p.id, { kind: 'open', payload: { price: 150, qty: 2, fee: 0.15, spreadCost: 0, slippageCost: 0 }, at: p.openedAt })
      await t.repos.positions.addEvent(p.id, { kind: 'funding', payload: { amount: 0.2 }, at: p.openedAt + H })
    }
    await close(overnight, S + 6 * H)
    await close(sameDay, S + 6 * H)

    const costs = (await restoreAt(S + 7 * H)).closedCosts
    expect(costs?.get('rl-overnight')).toEqual([
      { at: S, amount: -0.15 },
      { at: S + H, amount: -0.2 },
    ])
    // Abierta y cerrada el mismo día: no hace falta leer sus eventos.
    expect(costs?.has('rl-same-day')).toBe(false)
  })

  it('no trae la curva de capital: el pico sale de agregados de la base', async () => {
    await t.repos.equity.insert(SESSION, Array.from({ length: 500 }, (_, i) => equityAt(S + i * 60_000, 1_000 + (i % 50))))
    const series = vi.spyOn(t.repos.equity, 'series')
    try {
      expect((await restoreAt(S + 10 * H)).equityPeak).toBe(1_049)
      expect(series).not.toHaveBeenCalled()
    } finally {
      series.mockRestore()
    }
  })
})
