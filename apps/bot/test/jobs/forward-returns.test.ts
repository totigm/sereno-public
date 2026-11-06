import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Candle, Decision } from '@sereno/core'
import { signalRecord } from '@sereno/core/src/learning/state'
import { forwardReturnsAt, forwardReturnsJob } from '../../src/jobs/forward-returns'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'

const SESSION = 'ses_t21_forward'
const SYMBOL = 'FWDUSDT'
// Una moneda que salió del universo: sus velas no se guardaron y nunca van a estar.
const GONE = 'GONEUSDT'
const M15 = 900_000
const H = 3_600_000
const T = Date.UTC(2026, 9, 30, 12)

let t: TestDb

beforeAll(async () => {
  t = await openTestDb()
})

afterAll(async () => {
  await t.query('delete from sessions where id = $1', [SESSION])
  await t.query('delete from candles where symbol = $1', [SYMBOL])
  await t.close()
})

beforeEach(async () => {
  await seedSession(t, SESSION)
  await t.query('delete from candles where symbol = $1', [SYMBOL])
})

function decision(at: number, symbol = SYMBOL): Decision {
  return {
    t: at,
    symbol,
    composite: { S: 0, Sprime: 0, confidence: 0, signals: [], missing: [], weights: signalRecord(1), modifiers: { adx: 1, vol: 1 }, relVolume: 1, higherTrendAgainst: 0 },
    action: { kind: 'wait' },
  }
}

// Velas cerradas de 15m con cierre `close(openTime)`.
function candles(from: number, count: number, close: (openTime: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = from + i * M15
    const c = close(openTime)
    return { openTime, closeTime: openTime + M15 - 1, open: c, high: c, low: c, close: c, volume: 1, quoteVolume: c, trades: 1, takerBuyVolume: 0, takerBuyQuoteVolume: 0, closed: true }
  })
}

describe('forwardReturnsAt', () => {
  it('compara el cierre de la vela que decidió con el de la vela 16 (4 h) y 96 (24 h) posiciones después', () => {
    const closes = new Map([
      [T - M15, 100],
      [T + 14 * M15, 999],
      [T + 15 * M15, 110],
      [T + 95 * M15, 90],
    ])
    const r = forwardReturnsAt((openTime) => closes.get(openTime), T)
    expect(r.forwardReturn4h).toBeCloseTo(0.1, 12)
    expect(r.forwardReturn24h).toBeCloseTo(-0.1, 12)
    expect(forwardReturnsAt(() => undefined, T)).toEqual({ forwardReturn4h: null, forwardReturn24h: null })
  })
})

describe('forwardReturnsJob', () => {
  it('rellena los retornos con las velas guardadas; el de 24 h espera a que cierre su vela', async () => {
    const special = new Map([
      [T - M15, 100],
      [T + 15 * M15, 105],
    ])
    await t.repos.candles.upsertMany({ symbol: SYMBOL, timeframe: '15m', priceType: 'last' }, candles(T - 4 * M15, 30, (o) => special.get(o) ?? 50))
    await t.repos.decisions.insertBatch(SESSION, [decision(T), decision(T + H)])

    const filled = await forwardReturnsJob({ repos: t.repos, sessionId: SESSION, now: T + 5 * H })

    expect(filled).toBe(2)
    const rows = await t.repos.decisions.range(SESSION, T, T + 2 * H)
    expect(rows.map((r) => [r.candleCloseTime, r.forwardReturn4h, r.forwardReturn24h])).toEqual([
      [T, expect.closeTo(0.05, 12), null],
      [T + H, expect.closeTo(0, 12), null],
    ])
    // Sin velas nuevas no hay nada más que completar.
    expect(await forwardReturnsJob({ repos: t.repos, sessionId: SESSION, now: T + 5 * H })).toBe(0)
  })

  it('las más viejas que no se pueden completar no tapan a las nuevas aunque llenen páginas enteras', async () => {
    await t.repos.candles.upsertMany({ symbol: SYMBOL, timeframe: '15m', priceType: 'last' }, candles(T - 4 * M15, 40, () => 50))
    // Cinco páginas de dos de la moneda sin velas antes de las que sí se pueden completar.
    await t.repos.decisions.insertBatch(SESSION, [...Array.from({ length: 10 }, (_, i) => decision(T - H - i * M15, GONE)), decision(T), decision(T + M15)])

    const filled = await forwardReturnsJob({ repos: t.repos, sessionId: SESSION, now: T + 5 * H, pageSize: 2 })

    expect(filled).toBe(2)
    const rows = await t.repos.decisions.range(SESSION, T, T + H, { symbol: SYMBOL })
    expect(rows.map((r) => r.forwardReturn4h)).toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12)])
  })
})
