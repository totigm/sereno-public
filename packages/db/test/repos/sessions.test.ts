import { eq, sql } from 'drizzle-orm'
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LearningState } from '@sereno/core'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import type { DirectDb } from '../../src/client'
import { applyArchiveCloses, planArchiveCloses } from '../../src/repos/archive-close'
import { ActiveSessionExistsError, LearningSourceMissingError } from '../../src/repos/errors'
import { createLearningRepo } from '../../src/repos/learning'
import { createMarketRepo } from '../../src/repos/market'
import { createPositionsRepo } from '../../src/repos/positions'
import { createSessionsRepo } from '../../src/repos/sessions'
import { createSettingsRepo } from '../../src/repos/settings'
import { learningState, marketSnapshot, positionEvents, positions, sessions, settings, symbols } from '../../src/schema'
import { closed, position, replayReport } from './fixtures'
import { openTestDb, seedSession, sleep, truncate } from './helpers'

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, settings, learningState, positions, positionEvents, marketSnapshot, symbols)
})

const REPLAY_PARAMS = { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: false } as const

function learned(theta: number): LearningState {
  return {
    weightsGlobal: {
      trend15m: 1.2,
      trendHigher: 1,
      momentum: 0.8,
      breakout: 1,
      bands: 1,
      vwap: 1,
      funding: 1,
      openInterest: 1,
      positioning: 1,
      btcRegime: 1,
    },
    weightsBySymbol: { SOLUSDT: { momentum: 0.6 } },
    weeklyDelta: {
      trend15m: 0.2,
      trendHigher: 0,
      momentum: -0.2,
      breakout: 0,
      bands: 0,
      vwap: 0,
      funding: 0,
      openInterest: 0,
      positioning: 0,
      btcRegime: 0,
    },
    weekStart: Date.parse('2026-10-26T00:00:00Z'),
    confidenceBySymbol: { SOLUSDT: -0.1 },
    tradesBySymbol: { SOLUSDT: 9 },
    penalties: {},
    params: { theta, k: 1.5, tpR: 2, trailingR: 1, since: Date.parse('2026-10-20T00:00:00Z') },
    frozen: false,
    closedTrades: 57,
    version: 12,
  }
}

describe('sessionsRepo.createLive / getActive', () => {
  it('crea la simulación activa con el blindaje en I₀ y sus ajustes en versión 1', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero', by: 'toti@example.com' })
    expect(s).toMatchObject({ kind: 'paper_live', status: 'active', capitalInicial: 1000, baseBlindaje: 1000, protegido: 0 })
    expect(s.id).toMatch(/^ses_/)
    expect(s.settingsSnapshot).toEqual(DEFAULT_SETTINGS)
    expect(s.startedAt).toBeInstanceOf(Date)
    expect((await repo.getActive('paper_live'))?.id).toBe(s.id)
    const config = await createSettingsRepo(db).get(s.id)
    expect(config).toMatchObject({ version: 1, updatedBy: 'toti@example.com' })
    expect(await createSettingsRepo(db).history(s.id)).toHaveLength(1)
    expect(await createLearningRepo(db).get(s.id)).toBeNull()
  })

  it('no deja crear una segunda activa y no escribe nada de ella', async () => {
    const repo = createSessionsRepo(db)
    await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await expect(repo.createLive({ capitalInicial: 500, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })).rejects.toBeInstanceOf(
      ActiveSessionExistsError,
    )
    expect(await db.select().from(sessions)).toHaveLength(1)
    expect(await db.select().from(settings)).toHaveLength(1)
  })

  it('rechaza un capital inicial que no es positivo', async () => {
    const repo = createSessionsRepo(db)
    await expect(repo.createLive({ capitalInicial: 0, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })).rejects.toBeInstanceOf(RangeError)
  })

  it('continued copia el aprendizaje de la simulación en vivo más reciente', async () => {
    await seedSession(db, 'vieja')
    await createLearningRepo(db).save('vieja', learned(0.4))
    const s = await createSessionsRepo(db).createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'continued' })
    expect(s.learningOrigin).toBe('continued')
    expect(await createLearningRepo(db).get(s.id)).toEqual(learned(0.4))
  })

  it('replay:<id> copia el aprendizaje de ese replay', async () => {
    await seedSession(db, 'rep', { kind: 'replay', status: 'en_cola' })
    await createLearningRepo(db).save('rep', learned(0.45))
    const s = await createSessionsRepo(db).createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'replay:rep' })
    expect((await createLearningRepo(db).get(s.id))?.params.theta).toBe(0.45)
  })

  it('si el origen del aprendizaje no existe, no crea nada', async () => {
    const repo = createSessionsRepo(db)
    await expect(repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'replay:no-existe' })).rejects.toBeInstanceOf(
      LearningSourceMissingError,
    )
    await expect(repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'continued' })).rejects.toBeInstanceOf(
      LearningSourceMissingError,
    )
    expect(await db.select().from(sessions)).toHaveLength(0)
    expect(await db.select().from(settings)).toHaveLength(0)
  })
})

const REAL = { capitalInicial: 50, lossCap: 0.5, binanceEnv: 'testnet', by: 'toti@example.com' } as const
const PAPER = { capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' } as const

describe('sessionsRepo: la sesión con plata real', () => {
  it('createReal la crea prendida, con el tope en sus ajustes y el aprendizaje de cero', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReal(REAL)
    expect(r).toMatchObject({
      kind: 'live',
      name: 'Plata real',
      status: 'active',
      capitalInicial: 50,
      baseBlindaje: 50,
      protegido: 0,
      learningOrigin: 'zero',
      binanceEnv: 'testnet',
      realStatus: 'on',
      realOffReason: null,
    })
    expect(r.realChangedAt).toBeInstanceOf(Date)
    expect(r.settingsSnapshot).toEqual({ ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, lossCap: 0.5 } })
    expect(await createSettingsRepo(db).get(r.id)).toMatchObject({ version: 1, updatedBy: 'toti@example.com', config: { risk: { lossCap: 0.5 } } })
    expect(await createLearningRepo(db).get(r.id)).toBeNull()
    expect((await repo.getActive('live'))?.id).toBe(r.id)
    expect(await repo.getActive('paper_live')).toBeNull()
  })

  it('createReal rechaza un tope fuera de 0,1..1 o un capital que no es positivo, sin escribir nada', async () => {
    const repo = createSessionsRepo(db)
    await expect(repo.createReal({ ...REAL, lossCap: 0.05 })).rejects.toThrow()
    await expect(repo.createReal({ ...REAL, lossCap: 1.2 })).rejects.toThrow()
    await expect(repo.createReal({ ...REAL, capitalInicial: 0 })).rejects.toBeInstanceOf(RangeError)
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('una activa por tipo: papel y real conviven', async () => {
    const repo = createSessionsRepo(db)
    const paper = await repo.createLive(PAPER)
    const real = await repo.createReal(REAL)
    expect((await repo.getActive('paper_live'))?.id).toBe(paper.id)
    expect((await repo.getActive('live'))?.id).toBe(real.id)
    await expect(repo.createReal(REAL)).rejects.toBeInstanceOf(ActiveSessionExistsError)
    await expect(repo.createLive(PAPER)).rejects.toBeInstanceOf(ActiveSessionExistsError)
    expect(await db.select().from(sessions)).toHaveLength(2)
    expect(await db.select().from(settings)).toHaveLength(2)
  })

  it('crear una simulación no archiva la real', async () => {
    const repo = createSessionsRepo(db)
    const paper = await repo.createLive(PAPER)
    const real = await repo.createReal(REAL)
    await createPositionsRepo(db).upsertOpen(real.id, position('sol-real'))
    // Lo que hace "Nueva simulación": archivar la activa en papel y crear otra.
    const active = await repo.getActive('paper_live')
    expect(active?.id).toBe(paper.id)
    expect(await repo.archive(paper.id, { closeOpen: true })).toMatchObject({ archived: true })
    const nueva = await repo.createLive(PAPER)
    expect((await repo.getActive('paper_live'))?.id).toBe(nueva.id)
    expect(await repo.get(real.id)).toMatchObject({ status: 'active', realStatus: 'on', endedAt: null })
    expect((await createPositionsRepo(db).listOpen(real.id)).map((p) => p.id)).toEqual(['sol-real'])
  })

  it('archive rechaza la sesión real; archiveReal exige apagada y sin abiertas', async () => {
    const repo = createSessionsRepo(db)
    const pos = createPositionsRepo(db)
    const real = await repo.createReal(REAL)
    expect(await repo.archive(real.id, { closeOpen: false })).toEqual({ archived: false, reason: 'real_session', markAt: null })
    expect(await repo.archiveReal(real.id)).toEqual({ archived: false, reason: 'still_on' })
    expect(await repo.setRealStatus(real.id, 'off', 'user')).toBe(true)
    await pos.upsertOpen(real.id, position('sol'))
    expect(await repo.archiveReal(real.id)).toEqual({ archived: false, reason: 'open_positions' })
    expect((await repo.get(real.id))?.status).toBe('active')

    await pos.close(real.id, closed('sol'), 'Cerré SOL en el take profit.')
    expect(await repo.archiveReal(real.id)).toEqual({ archived: true })
    const archivada = await repo.get(real.id)
    expect(archivada).toMatchObject({ status: 'archived', realStatus: 'off' })
    expect(archivada?.endedAt).toBeInstanceOf(Date)
    expect(await repo.archiveReal(real.id)).toEqual({ archived: false, reason: 'not_active' })
    // Archivada la anterior, se puede crear otra.
    expect((await repo.createReal(REAL)).id).not.toBe(real.id)
  })

  it('archiveReal no archiva una simulación en papel', async () => {
    const repo = createSessionsRepo(db)
    const paper = await repo.createLive(PAPER)
    expect(await repo.archiveReal(paper.id)).toEqual({ archived: false, reason: 'not_active' })
    expect((await repo.get(paper.id))?.status).toBe('active')
  })

  it('setRealStatus apaga y prende con su motivo; no toca una simulación en papel', async () => {
    const repo = createSessionsRepo(db)
    const real = await repo.createReal(REAL)
    expect(await repo.setRealStatus(real.id, 'off', 'fatal')).toBe(true)
    const apagada = await repo.get(real.id)
    expect(apagada).toMatchObject({ realStatus: 'off', realOffReason: 'fatal' })
    expect(apagada?.realChangedAt?.getTime()).toBeGreaterThan(real.realChangedAt?.getTime() ?? Infinity)
    // Apagar una ya apagada no mueve el instante del cambio.
    await sleep(5)
    expect(await repo.setRealStatus(real.id, 'off', 'user')).toBe(true)
    expect(await repo.get(real.id)).toMatchObject({ realStatus: 'off', realOffReason: 'user', realChangedAt: apagada?.realChangedAt })
    expect(await repo.setRealStatus(real.id, 'on', null)).toBe(true)
    expect(await repo.get(real.id)).toMatchObject({ realStatus: 'on', realOffReason: null })

    const paper = await repo.createLive(PAPER)
    expect(await repo.setRealStatus(paper.id, 'off', 'user')).toBe(false)
    expect(await repo.get(paper.id)).toMatchObject({ realStatus: null, realOffReason: null, realChangedAt: null })
    expect(await repo.setRealStatus('no-existe', 'off', 'user')).toBe(false)
  })

  it('loss_floor es terminal', async () => {
    const repo = createSessionsRepo(db)
    const real = await repo.createReal(REAL)
    expect(await repo.setRealStatus(real.id, 'loss_floor', null)).toBe(true)
    expect(await repo.setRealStatus(real.id, 'on', null)).toBe(false)
    expect(await repo.setRealStatus(real.id, 'off', 'user')).toBe(false)
    expect(await repo.get(real.id)).toMatchObject({ realStatus: 'loss_floor', realOffReason: null })
    // Sin abiertas, la del tope se archiva para dejar lugar a una nueva.
    expect(await repo.archiveReal(real.id)).toEqual({ archived: true })
  })

  it('continued no copia el aprendizaje de la real', async () => {
    const repo = createSessionsRepo(db)
    await seedSession(db, 'papel-vieja')
    await createLearningRepo(db).save('papel-vieja', learned(0.4))
    // La real es más nueva y también aprendió: no cuenta como origen.
    const real = await repo.createReal(REAL)
    await createLearningRepo(db).save(real.id, learned(0.5))
    const s = await repo.createLive({ ...PAPER, learningOrigin: 'continued' })
    expect((await createLearningRepo(db).get(s.id))?.params.theta).toBe(0.4)
  })
})

const BTC_SYMBOL = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  contractType: 'PERPETUAL',
  status: 'TRADING',
  minNotional: 100,
  minQty: 0.001,
  stepSize: 0.001,
  tickSize: 0.1,
  quantityPrecision: 3,
  underlyingType: 'COIN',
  underlyingSubType: [],
  onboardDate: new Date('2019-09-25T00:00:00Z'),
  fundingIntervalHours: 8,
  liquidationFee: 0.0125,
  mmr: 0.004,
  observedSpread: 0.00005,
}

const SOL_AT_130 = { symbol: 'SOLUSDT', markPrice: 130, change24h: 0.02, sPrime: 0.3, lean: 0.3, state: 'in_position' } as const

// Envejece el snapshot de mercado de la sesión, con el reloj de la base.
async function ageSnapshot(sessionId: string, interval: string): Promise<void> {
  await db
    .update(marketSnapshot)
    .set({ updatedAt: sql`now() - ${interval}::interval` })
    .where(eq(marketSnapshot.sessionId, sessionId))
}

describe('sessionsRepo.archive', () => {
  it('un cierre del plan que no escribe frena el archivo en vez de informarlo cerrado', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    const pos = createPositionsRepo(db)
    await pos.upsertOpen(s.id, position('sol'))
    await createMarketRepo(db).upsert(s.id, [SOL_AT_130])

    const archiving = db.transaction(async (tx) => {
      const plan = await planArchiveCloses(tx, s, 60_000)
      assert(plan.fresh)
      // Invariante roto a propósito: la fila del plan ya no está abierta.
      await createPositionsRepo(tx).close(s.id, closed('sol'), 'Cerré el long en SOL.')
      await applyArchiveCloses(tx, s.id, plan, Date.parse('2026-10-31T15:00:00Z'))
    })
    await expect(archiving).rejects.toThrow('No pude cerrar sol al archivar la simulación: ya no estaba abierta en la sesión')
    expect(await pos.listEvents('sol')).toEqual([])
    expect((await pos.listOpen(s.id)).map((p) => p.id)).toEqual(['sol'])
  })

  it('archiva y cierra las abiertas al último precio de marca; sin precio o degradada, la deja abierta', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    const pos = createPositionsRepo(db)
    await pos.upsertOpen(s.id, position('sol'))
    await pos.upsertOpen(
      s.id,
      position('btc', { symbol: 'BTCUSDT', side: 'short', entryPrice: 70_000, qty: 0.01, feesPaid: 0.35, fundingPaid: 0.1, riesgoReal: 7, shadow: true }),
    )
    await pos.upsertOpen(s.id, position('eth', { symbol: 'ETHUSDT' }))
    await pos.upsertOpen(s.id, position('doge', { symbol: 'DOGEUSDT' }))
    await db.insert(symbols).values(BTC_SYMBOL)
    const market = createMarketRepo(db)
    await market.upsert(s.id, [
      SOL_AT_130,
      { symbol: 'BTCUSDT', markPrice: 69_000, change24h: -0.01, sPrime: -0.2, lean: -0.2, state: 'in_position' },
      // Sin datos hace rato: su marca es vieja aunque el snapshot sea nuevo.
      { symbol: 'DOGEUSDT', markPrice: 0.2, change24h: null, sPrime: null, lean: 0, state: 'degraded', staleSince: '2026-10-31T09:00:00Z' },
    ])
    const snapshot = await market.get(s.id)

    const res = await repo.archive(s.id, { closeOpen: true })
    assert(res.archived)
    expect(res.markAt).toEqual(snapshot?.updatedAt)
    expect(res.leftOpen).toEqual(['doge', 'eth'])
    const porId = new Map(res.closed.map((c) => [c.id, c]))
    expect(porId.get('sol')?.pnlNet).toBeCloseTo(9.6280585, 8)
    // BTC usa el medio spread observado, no el de por defecto.
    expect(porId.get('btc')?.exitPrice).toBeCloseTo(69_017.25, 8)

    const archivada = await repo.get(s.id)
    expect(archivada?.status).toBe('archived')
    expect(archivada?.endedAt).toBeInstanceOf(Date)
    expect(await repo.getActive('paper_live')).toBeNull()
    const { items } = await pos.listClosed(s.id)
    expect(items.map((p) => p.id)).toEqual(['sol'])
    expect(items[0]).toMatchObject({ closeReason: 'session_archived', closedAt: archivada?.endedAt?.getTime() })
    expect(items[0]?.costs.spread).toBeCloseTo(0.1275, 10)
    expect((await pos.listOpen(s.id)).map((p) => p.id)).toEqual(['doge', 'eth'])
    expect((await pos.listEvents('sol')).map((e) => e.kind)).toEqual(['close'])
  })

  it('con un precio de marca viejo no archiva ni cierra nada, y dice de cuándo es el precio', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await createPositionsRepo(db).upsertOpen(s.id, position('sol'))
    await createMarketRepo(db).upsert(s.id, [SOL_AT_130])
    // El bot lleva 10 horas apagado.
    await ageSnapshot(s.id, '10 hours')
    const snapshot = await createMarketRepo(db).get(s.id)

    expect(await repo.archive(s.id, { closeOpen: true })).toEqual({ archived: false, reason: 'stale_mark', markAt: snapshot?.updatedAt })
    expect((await repo.get(s.id))?.status).toBe('active')
    expect((await createPositionsRepo(db).listOpen(s.id)).map((p) => p.id)).toEqual(['sol'])
    expect(await createPositionsRepo(db).listEvents('sol')).toEqual([])

    // Quien llama puede archivar igual, dejando las abiertas como estaban.
    expect(await repo.archive(s.id, { closeOpen: false })).toEqual({ archived: true, closed: [], leftOpen: ['sol'], markAt: null })
    expect((await createPositionsRepo(db).listOpen(s.id)).map((p) => p.id)).toEqual(['sol'])
  })

  it('sin snapshot de mercado tampoco cierra al archivar', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await createPositionsRepo(db).upsertOpen(s.id, position('sol'))
    expect(await repo.archive(s.id, { closeOpen: true })).toEqual({ archived: false, reason: 'stale_mark', markAt: null })
    expect((await repo.get(s.id))?.status).toBe('active')
  })

  it('la antigüedad tolerada se puede ajustar; sin abiertas, un precio viejo no importa', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await createPositionsRepo(db).upsertOpen(s.id, position('sol'))
    await createMarketRepo(db).upsert(s.id, [SOL_AT_130])
    await ageSnapshot(s.id, '30 minutes')
    const res = await repo.archive(s.id, { closeOpen: true, maxMarkAgeMs: 3_600_000 })
    assert(res.archived)
    expect(res.closed.map((c) => c.id)).toEqual(['sol'])

    const otra = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await createMarketRepo(db).upsert(otra.id, [SOL_AT_130])
    await ageSnapshot(otra.id, '10 hours')
    expect(await repo.archive(otra.id, { closeOpen: true })).toEqual({ archived: true, closed: [], leftOpen: [], markAt: null })
  })

  it('sin closeOpen deja las abiertas como estaban y dice cuáles quedaron, reales y sombra', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    const pos = createPositionsRepo(db)
    await pos.upsertOpen(s.id, position('sol'))
    await pos.upsertOpen(s.id, position('btc', { symbol: 'BTCUSDT', shadow: true }))
    await pos.close(s.id, closed('eth', { symbol: 'ETHUSDT' }), 'Cerré ETH en el take profit.')
    await createMarketRepo(db).upsert(s.id, [{ symbol: 'SOLUSDT', markPrice: 130, change24h: null, sPrime: null, lean: 0, state: 'ready' }])
    expect(await repo.archive(s.id, { closeOpen: false })).toEqual({ archived: true, closed: [], leftOpen: ['btc', 'sol'], markAt: null })
    expect(await pos.listOpen(s.id)).toHaveLength(1)
    expect(await pos.listOpen(s.id, { shadow: true })).toHaveLength(1)
  })

  it('el plan bloquea las abiertas: una escritura del bot en curso termina antes y el cierre parte de ella', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await createPositionsRepo(db).upsertOpen(s.id, position('sol'))
    await createMarketRepo(db).upsert(s.id, [SOL_AT_130])
    // El bot cobra un funding de la abierta y todavía no confirmó: cambiar la fila
    // sin tocar `session_id` no pasa por el bloqueo de la sesión.
    const bot = await db.$client.connect()
    try {
      await bot.query('BEGIN')
      await bot.query(`UPDATE positions SET funding = 0.5 WHERE id = 'sol'`)
      const archiving = repo.archive(s.id, { closeOpen: true })
      await sleep(150)
      await bot.query('COMMIT')
      const res = await archiving
      assert(res.archived)
      // 9,6280585 con funding 0: el cierre usa el 0,5 que el bot dejó confirmado.
      expect(res.closed[0]?.pnlNet).toBeCloseTo(9.6280585 - 0.5, 8)
    } finally {
      bot.release()
    }
    const [cerrada] = (await createPositionsRepo(db).listClosed(s.id)).items
    expect(cerrada).toMatchObject({ fundingPaid: 0.5, costs: expect.objectContaining({ funding: 0.5 }) })
  })

  it('una sesión que no está activa no se archiva; después se puede crear otra', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    await repo.archive(s.id, { closeOpen: true })
    expect(await repo.archive(s.id, { closeOpen: true })).toEqual({ archived: false, reason: 'not_active', markAt: null })
    const nueva = await repo.createLive({ capitalInicial: 2000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect((await repo.getActive('paper_live'))?.id).toBe(nueva.id)
  })
})

describe('sessionsRepo replays, listAll y blindaje', () => {
  it('createReplay queda en cola con sus parámetros y no cuenta como activa', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReplay({
      name: 'Replay · 90 días',
      capitalInicial: 1000,
      settings: DEFAULT_SETTINGS,
      learningOrigin: 'zero',
      replayParams: REPLAY_PARAMS,
    })
    expect(r).toMatchObject({ kind: 'replay', status: 'en_cola', progreso: 0, replayParams: REPLAY_PARAMS })
    expect(await repo.getActive('paper_live')).toBeNull()
  })

  it('updateProgress avanza el replay y, una vez terminado, no lo cambia más', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReplay({ name: 'R', capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero', replayParams: REPLAY_PARAMS })
    expect(await repo.updateProgress(r.id, { status: 'descargando', progreso: 0.4, mensaje: 'Descargando velas · 12 de 30 monedas' })).toBe(true)
    expect(await repo.get(r.id)).toMatchObject({ status: 'descargando', progreso: 0.4, endedAt: null })
    expect(await repo.updateProgress(r.id, { status: 'cancelado', progreso: 0.4, mensaje: 'Cancelado' })).toBe(true)
    expect((await repo.get(r.id))?.endedAt).toBeInstanceOf(Date)
    expect(await repo.updateProgress(r.id, { status: 'simulando', progreso: 0.5, mensaje: 'Simulando · día 41 de 90' })).toBe(false)
    expect((await repo.get(r.id))?.status).toBe('cancelado')
  })

  it('updateProgress no toca sesiones en vivo', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect(await repo.updateProgress(s.id, { status: 'listo', progreso: 1, mensaje: 'x' })).toBe(false)
    expect((await repo.get(s.id))?.status).toBe('active')
  })

  it('listReplays devuelve los replays en esos estados en el orden en que se pidieron', async () => {
    const repo = createSessionsRepo(db)
    const input = { capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero', replayParams: REPLAY_PARAMS } as const
    const first = await repo.createReplay({ ...input, name: 'Primero' })
    const second = await repo.createReplay({ ...input, name: 'Segundo' })
    const third = await repo.createReplay({ ...input, name: 'Tercero' })
    await db.update(sessions).set({ startedAt: new Date('2026-10-31T10:00:00Z') }).where(eq(sessions.id, first.id))
    await db.update(sessions).set({ startedAt: new Date('2026-10-31T10:00:01Z') }).where(eq(sessions.id, second.id))
    await db.update(sessions).set({ startedAt: new Date('2026-10-31T10:00:02Z') }).where(eq(sessions.id, third.id))
    await repo.updateProgress(second.id, { status: 'simulando', progreso: 0.5, mensaje: 'Simulando · día 1 de 2' })
    await repo.updateProgress(third.id, { status: 'cancelado', progreso: 0, mensaje: 'Cancelado' })
    await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect((await repo.listReplays(['en_cola', 'simulando'])).map((r) => r.id)).toEqual([first.id, second.id])
    expect((await repo.listReplays(['cancelado'])).map((r) => r.id)).toEqual([third.id])
    expect(await repo.listReplays([])).toEqual([])
  })

  it('completeReplay deja el replay listo con su reporte en `sessions.report`; los listados no lo traen', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReplay({ name: 'R', capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero', replayParams: REPLAY_PARAMS })
    expect(r).not.toHaveProperty('report')
    expect(await repo.getReport(r.id)).toBeNull()
    await repo.updateProgress(r.id, { status: 'simulando', progreso: 0.9, mensaje: 'Simulando · día 3 de 3' })

    expect(await repo.completeReplay(r.id, { report: replayReport(1000), mensaje: 'Listo · 0 trades cerrados' })).toBe(true)
    expect(await repo.get(r.id)).toMatchObject({ status: 'listo', progreso: 1, mensaje: 'Listo · 0 trades cerrados' })
    expect((await repo.get(r.id))?.endedAt).toBeInstanceOf(Date)
    expect(await repo.getReport(r.id)).toEqual(replayReport(1000))
    const [stored] = await db.select({ report: sessions.report }).from(sessions).where(eq(sessions.id, r.id))
    expect(stored?.report?.capital).toBe(1000)
    // El selector de sesiones y la cola no cargan reportes de decenas de KB.
    expect(await repo.get(r.id)).not.toHaveProperty('report')
    expect((await repo.listAll())[0]).not.toHaveProperty('report')
    expect((await repo.listReplays(['listo']))[0]).not.toHaveProperty('report')
    // Terminado, no cambia más.
    expect(await repo.completeReplay(r.id, { report: replayReport(2000), mensaje: 'Listo' })).toBe(false)
    expect((await repo.getReport(r.id))?.capital).toBe(1000)
  })

  it('completeReplay no pisa un replay cancelado ni toca sesiones en vivo', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReplay({ name: 'R', capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero', replayParams: REPLAY_PARAMS })
    await repo.updateProgress(r.id, { status: 'cancelado', progreso: 0.5, mensaje: 'Cancelado a pedido tuyo.' })
    expect(await repo.completeReplay(r.id, { report: replayReport(1000), mensaje: 'Listo' })).toBe(false)
    expect(await repo.get(r.id)).toMatchObject({ status: 'cancelado', mensaje: 'Cancelado a pedido tuyo.' })
    expect(await repo.getReport(r.id)).toBeNull()
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect(await repo.completeReplay(s.id, { report: replayReport(1000), mensaje: 'Listo' })).toBe(false)
    expect((await repo.get(s.id))?.status).toBe('active')
  })

  it('setReplayLearningOrigin corrige el origen del aprendizaje de un replay y no el de una sesión en vivo', async () => {
    const repo = createSessionsRepo(db)
    const r = await repo.createReplay({ name: 'R', capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'continued', replayParams: { ...REPLAY_PARAMS, learningOrigin: 'current' } })
    expect(await repo.setReplayLearningOrigin(r.id, 'zero')).toBe(true)
    expect((await repo.get(r.id))?.learningOrigin).toBe('zero')
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect(await repo.setReplayLearningOrigin(s.id, 'continued')).toBe(false)
    expect((await repo.get(s.id))?.learningOrigin).toBe('zero')
  })

  it('listAll devuelve las más recientes primero y get null si no existe', async () => {
    const repo = createSessionsRepo(db)
    await seedSession(db, 'vieja')
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect((await repo.listAll()).map((x) => x.id)).toEqual([s.id, 'vieja'])
    expect(await repo.get('no-existe')).toBeNull()
  })

  it('updateShield guarda protegido y base de blindaje', async () => {
    const repo = createSessionsRepo(db)
    const s = await repo.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
    expect(await repo.updateShield(s.id, { protegido: 1000, baseBlindaje: 1000 })).toBe(true)
    expect(await repo.get(s.id)).toMatchObject({ protegido: 1000, baseBlindaje: 1000 })
  })
})
