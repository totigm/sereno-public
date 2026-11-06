import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Decision } from '@sereno/core'
import type { EquityPoint } from '@sereno/db'
import { cleanup, DECISIONS_RETENTION_DAYS, MINUTE_EQUITY_RETENTION_DAYS } from '../../src/jobs/cleanup'
import { silentLogger } from '../../src/logger'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 31, 0, 5, 0)
const LIVE = 'ses_t19_cleanup_live'
const REPLAY = 'ses_t19_cleanup_replay'

let t: TestDb

beforeAll(async () => {
  t = await openTestDb()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  await seedSession(t, LIVE)
  await seedSession(t, REPLAY, 'replay')
})

function decision(at: number): Decision {
  return {
    t: at,
    symbol: 'SOLUSDT',
    composite: {
      S: 0.1,
      Sprime: 0.1,
      confidence: 0.1,
      signals: [{ id: 'trend15m', value: 0.1 }],
      missing: [],
      weights: { trend15m: 1, trendHigher: 1, momentum: 1, breakout: 1, bands: 1, vwap: 1, funding: 1, openInterest: 1, positioning: 1, btcRegime: 1 },
      modifiers: { adx: 1, vol: 1 },
      relVolume: 1,
      higherTrendAgainst: 0,
    },
    action: { kind: 'wait' },
  }
}

function equity(at: number, kind: EquityPoint['kind']): EquityPoint {
  return { at, saldo: 1000, equity: 1000, margenEnUso: 0, protegido: 0, capitalBase: 1000, capitalOperable: 1000, shadowEquity: null, kind }
}

describe('cleanup', () => {
  it('borra decisiones de más de 30 días y equity por minuto de más de 90 días, sólo en vivo', async () => {
    expect(DECISIONS_RETENTION_DAYS).toBe(30)
    expect(MINUTE_EQUITY_RETENTION_DAYS).toBe(90)
    const old = NOW - 31 * DAY
    const recent = NOW - 29 * DAY
    await t.repos.decisions.insertBatch(LIVE, [decision(old), decision(recent)])
    await t.repos.decisions.insertBatch(REPLAY, [decision(old)])
    const ancient = NOW - 91 * DAY
    await t.repos.equity.insert(LIVE, [equity(ancient, 'minute'), equity(NOW - 89 * DAY, 'minute'), equity(ancient, 'event')])
    await t.repos.equity.insert(REPLAY, [equity(ancient, 'minute')])

    const result = await cleanup({ repos: t.repos, now: () => NOW, logger: silentLogger })

    // Los totales cuentan todas las sesiones en vivo de la base: se miran las filas de este
    // archivo, y de los totales sólo que incluyan lo borrado acá.
    expect(result.decisions).toBeGreaterThanOrEqual(1)
    expect(result.minuteEquity).toBeGreaterThanOrEqual(1)
    expect((await t.repos.decisions.range(LIVE, 0, NOW)).map((d) => d.candleCloseTime)).toEqual([recent])
    expect(await t.repos.decisions.range(REPLAY, 0, NOW)).toHaveLength(1)
    const liveEquity = await t.repos.equity.series(LIVE, 0, NOW)
    expect(liveEquity.map((p) => [p.at, p.kind])).toEqual([
      [ancient, 'event'],
      [NOW - 89 * DAY, 'minute'],
    ])
    expect(await t.repos.equity.series(REPLAY, 0, NOW)).toHaveLength(1)
  })

  it('sin nada viejo no borra nada de la sesión', async () => {
    await t.repos.decisions.insertBatch(LIVE, [decision(NOW - DAY)])
    await t.repos.equity.insert(LIVE, [equity(NOW - 89 * DAY, 'minute')])
    await cleanup({ repos: t.repos, now: () => NOW, logger: silentLogger })
    expect(await t.repos.decisions.range(LIVE, 0, NOW)).toHaveLength(1)
    expect(await t.repos.equity.series(LIVE, 0, NOW)).toHaveLength(1)
  })
})
