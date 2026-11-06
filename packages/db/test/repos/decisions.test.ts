import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Composite, Decision, DecisionAction, EntryPlan } from '@sereno/core'
import type { DirectDb } from '../../src/client'
import { createDecisionsRepo } from '../../src/repos/decisions'
import { decisions, sessions } from '../../src/schema'
import { SIGNALS } from './fixtures'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_dec'
const REPLAY = 'ses_dec_replay'
const H = 3_600_000
const T = Date.parse('2026-10-31T00:00:00Z')
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, decisions)
  await seedSession(db, SESSION)
  await seedSession(db, REPLAY, { kind: 'replay', status: 'en_cola' })
})

function composite(Sprime: number): Composite {
  return {
    S: Sprime * 1.1,
    Sprime,
    confidence: 0.8,
    signals: SIGNALS,
    missing: ['funding'],
    weights: {
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
    },
    modifiers: { adx: 1, vol: 1 },
    relVolume: 1.2,
    higherTrendAgainst: 0,
  }
}

const PLAN = { side: 'short' } as EntryPlan

function decision(t: number, symbol: string, Sprime: number, action: DecisionAction, shadow?: Decision['shadow']): Decision {
  return { t, symbol, composite: composite(Sprime), action, ...(shadow ? { shadow } : {}) }
}

const blocked = (reason: 'low_volume' | 'max_positions'): DecisionAction => ({ kind: 'blocked', reason, wantedSide: 'long' })

describe('decisionsRepo.insertBatch / range', () => {
  it('guarda el lote con las etiquetas de acción de la spec y la sombra', async () => {
    const repo = createDecisionsRepo(db)
    const n = await repo.insertBatch(SESSION, [
      decision(T, 'SOLUSDT', -0.5, { kind: 'enter', plan: PLAN }, { Sprime: -0.4, action: 'enter' }),
      decision(T, 'BTCUSDT', 0.1, { kind: 'wait' }, { Sprime: 0.1, action: 'wait' }),
      decision(T, 'ETHUSDT', 0.4, blocked('low_volume')),
    ])
    expect(n).toBe(3)
    const filas = await repo.range(SESSION, T, T + 1)
    const porMoneda = new Map(filas.map((f) => [f.symbol, f]))
    expect(porMoneda.get('SOLUSDT')).toMatchObject({ action: 'enter_short', blockedBy: null, shadowAction: 'enter_short', sPrime: -0.5 })
    expect(porMoneda.get('BTCUSDT')).toMatchObject({ action: 'wait', shadowAction: 'wait' })
    expect(porMoneda.get('ETHUSDT')).toMatchObject({ action: 'blocked:low_volume', blockedBy: 'low_volume', shadowAction: null })
    expect(porMoneda.get('ETHUSDT')).toMatchObject({ candleCloseTime: T, signals: SIGNALS, missingSignals: ['funding'] })
    expect(porMoneda.get('ETHUSDT')?.s).toBeCloseTo(0.44, 10)
  })

  it('range filtra por moneda y respeta [from, to)', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [
      decision(T, 'SOLUSDT', 0.1, { kind: 'wait' }),
      decision(T + H, 'SOLUSDT', 0.2, { kind: 'wait' }),
      decision(T + H, 'BTCUSDT', 0.2, { kind: 'wait' }),
    ])
    expect((await repo.range(SESSION, T, T + H)).map((d) => d.sPrime)).toEqual([0.1])
    expect((await repo.range(SESSION, T, T + 2 * H, { symbol: 'SOLUSDT' })).map((d) => d.candleCloseTime)).toEqual([T, T + H])
  })

  it('guarda los retornos que ya se conocen al insertar (un replay tiene las velas siguientes)', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(
      SESSION,
      [decision(T, 'SOLUSDT', 0.1, { kind: 'wait' }), decision(T, 'BTCUSDT', 0.2, { kind: 'wait' })],
      (d) => (d.symbol === 'SOLUSDT' ? { forwardReturn4h: 0.01, forwardReturn24h: null } : { forwardReturn4h: null, forwardReturn24h: null }),
    )
    const filas = new Map((await repo.range(SESSION, T, T + 1)).map((f) => [f.symbol, f]))
    expect(filas.get('SOLUSDT')).toMatchObject({ forwardReturn4h: 0.01, forwardReturn24h: null })
    expect(filas.get('BTCUSDT')).toMatchObject({ forwardReturn4h: null, forwardReturn24h: null })
  })
})

describe('decisionsRepo forward returns', () => {
  it('lista las que ya pueden tener retorno y los rellena sin pisar lo que ya estaba', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [
      decision(T, 'SOLUSDT', 0.1, { kind: 'wait' }),
      decision(T + 20 * H, 'SOLUSDT', 0.1, { kind: 'wait' }),
      decision(T + 23 * H, 'SOLUSDT', 0.1, { kind: 'wait' }),
    ])
    const now = T + 25 * H
    // La de T+23h todavía no cumplió 4 horas.
    const pendientes = await repo.listPendingForwardReturns(SESSION, now)
    expect(pendientes.map((d) => d.candleCloseTime)).toEqual([T, T + 20 * H])
    const [vieja, media] = pendientes
    if (!vieja || !media) throw new Error('faltan pendientes')

    expect(
      await repo.fillForwardReturns([
        { id: vieja.id, forwardReturn4h: 0.012, forwardReturn24h: -0.03 },
        { id: media.id, forwardReturn4h: 0.005 },
      ]),
    ).toBe(2)
    // Ya no falta ninguna a 4 h; la de T+20h sigue pendiente a 24 h (y la de T+23h, de las dos).
    expect(await repo.listPendingForwardReturns(SESSION, now)).toEqual([])
    expect((await repo.listPendingForwardReturns(SESSION, T + 44 * H)).map((d) => d.candleCloseTime)).toEqual([T + 20 * H, T + 23 * H])

    await repo.fillForwardReturns([{ id: media.id, forwardReturn24h: 0.02 }])
    const [a, b] = await repo.range(SESSION, T, T + 21 * H)
    expect(a).toMatchObject({ forwardReturn4h: 0.012, forwardReturn24h: -0.03 })
    expect(b).toMatchObject({ forwardReturn4h: 0.005, forwardReturn24h: 0.02 })
  })
})

describe('decisionsRepo.listPendingForwardReturns: horizonte', () => {
  it('a los 7 días deja de listar las que nunca tuvieron velas, así no tapan a las nuevas', async () => {
    const repo = createDecisionsRepo(db)
    const D = 24 * H
    await repo.insertBatch(SESSION, [
      // Una moneda deslistada: sus velas no van a llegar nunca.
      decision(T, 'XYZUSDT', 0.1, { kind: 'wait' }),
      decision(T + 2 * D, 'SOLUSDT', 0.1, { kind: 'wait' }),
      decision(T + 3 * D, 'SOLUSDT', 0.1, { kind: 'wait' }),
    ])
    const now = T + 8 * D
    expect((await repo.listPendingForwardReturns(SESSION, now)).map((d) => d.candleCloseTime)).toEqual([T + 2 * D, T + 3 * D])
    expect((await repo.listPendingForwardReturns(SESSION, now, { maxAgeMs: 10 * D })).map((d) => d.symbol)).toEqual([
      'XYZUSDT',
      'SOLUSDT',
      'SOLUSDT',
    ])
    expect((await repo.listPendingForwardReturns(SESSION, now, { limit: 1 })).map((d) => d.candleCloseTime)).toEqual([T + 2 * D])
  })

  it('con `after` sigue desde la última que vio (por cierre y por id), sin volver a las anteriores', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [
      decision(T, 'XYZUSDT', 0.1, { kind: 'wait' }),
      decision(T, 'SOLUSDT', 0.1, { kind: 'wait' }),
      decision(T + H, 'SOLUSDT', 0.1, { kind: 'wait' }),
    ])
    const now = T + 30 * H
    const [first, second, third] = await repo.listPendingForwardReturns(SESSION, now)
    if (!first || !second || !third) throw new Error('faltan pendientes')

    const after = (d: typeof first) => ({ candleCloseTime: d.candleCloseTime, id: d.id })
    expect((await repo.listPendingForwardReturns(SESSION, now, { after: after(first) })).map((d) => d.id)).toEqual([second.id, third.id])
    expect((await repo.listPendingForwardReturns(SESSION, now, { after: after(second), limit: 1 })).map((d) => d.id)).toEqual([third.id])
    expect(await repo.listPendingForwardReturns(SESSION, now, { after: after(third) })).toEqual([])
  })
})

describe('decisionsRepo.listJournalCandidates', () => {
  it('bloqueadas con |S′| cerca del umbral, una por moneda cada 4 horas, las más nuevas primero', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [
      decision(T, 'SOLUSDT', 0.3, blocked('low_volume')),
      // Misma moneda 1 h después: dentro de la ventana de 4 h, no entra.
      decision(T + H, 'SOLUSDT', -0.31, blocked('max_positions')),
      decision(T + 4 * H, 'SOLUSDT', 0.28, blocked('low_volume')),
      decision(T + H, 'BTCUSDT', 0.27, blocked('low_volume')),
      // Bajo el mínimo de |S′|.
      decision(T + 2 * H, 'ETHUSDT', 0.2, blocked('low_volume')),
      // Esperas y entradas no son candidatas.
      decision(T + 2 * H, 'XRPUSDT', 0.3, { kind: 'wait' }),
      decision(T + 2 * H, 'ADAUSDT', 0.5, { kind: 'enter', plan: PLAN }),
    ])
    const c = await repo.listJournalCandidates(SESSION, { from: T, minAbsSPrime: 0.25 })
    expect(c.map((d) => [d.symbol, d.candleCloseTime])).toEqual([
      ['SOLUSDT', T + 4 * H],
      ['BTCUSDT', T + H],
      ['SOLUSDT', T],
    ])
    expect((await repo.listJournalCandidates(SESSION, { from: T + H, to: T + 4 * H, minAbsSPrime: 0.25 })).map((d) => d.symbol)).toEqual([
      'BTCUSDT',
      'SOLUSDT',
    ])
  })

  it('con limit devuelve sólo las más nuevas, espaciadas igual que sin límite', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [
      decision(T, 'SOLUSDT', 0.3, blocked('low_volume')),
      decision(T + 3 * H, 'SOLUSDT', 0.3, blocked('low_volume')),
      decision(T + 5 * H, 'SOLUSDT', 0.3, blocked('low_volume')),
      decision(T + 6 * H, 'BTCUSDT', 0.3, blocked('low_volume')),
    ])
    // Espaciadas desde el principio: T y T+5h (la de T+3h cae en la ventana de T).
    const c = await repo.listJournalCandidates(SESSION, { from: T, minAbsSPrime: 0.25, limit: 2 })
    expect(c.map((d) => [d.symbol, d.candleCloseTime])).toEqual([
      ['BTCUSDT', T + 6 * H],
      ['SOLUSDT', T + 5 * H],
    ])
    expect(c[0]).toMatchObject({ signals: SIGNALS, sessionId: SESSION })
    expect(await repo.listJournalCandidates(SESSION, { from: T + 7 * H, minAbsSPrime: 0.25, limit: 2 })).toEqual([])
  })
})

describe('decisionsRepo.pruneOlderThan', () => {
  it('borra lo viejo de las sesiones en vivo y deja los replays completos', async () => {
    const repo = createDecisionsRepo(db)
    await repo.insertBatch(SESSION, [decision(T, 'SOLUSDT', 0.1, { kind: 'wait' }), decision(T + 2 * H, 'SOLUSDT', 0.1, { kind: 'wait' })])
    await repo.insertBatch(REPLAY, [decision(T, 'SOLUSDT', 0.1, { kind: 'wait' })])
    expect(await repo.pruneOlderThan(T + H)).toBe(1)
    expect((await repo.range(SESSION, 0, T + 10 * H)).map((d) => d.candleCloseTime)).toEqual([T + 2 * H])
    expect(await repo.range(REPLAY, 0, T + 10 * H)).toHaveLength(1)
  })
})
