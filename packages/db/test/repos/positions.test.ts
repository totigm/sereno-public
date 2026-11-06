import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DirectDb } from '../../src/client'
import { SessionArchivedError } from '../../src/repos/errors'
import { createPositionsRepo } from '../../src/repos/positions'
import { positionEvents, positions, sessions } from '../../src/schema'
import { closed, position } from './fixtures'
import { openTestDb, seedSession, sleep, truncate } from './helpers'

const SESSION = 'ses_pos'
let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions, positions, positionEvents)
  await seedSession(db, SESSION, { status: 'active' })
})

describe('positionsRepo.upsertOpen / listOpen', () => {
  it('da de alta, devuelve la posición del motor tal cual y deriva las señales faltantes', async () => {
    const repo = createPositionsRepo(db)
    const p = position('pos-1')
    expect(await repo.upsertOpen(SESSION, p, { latencyMs: 420 })).toBe(true)
    const [abierta] = await repo.listOpen(SESSION)
    expect(abierta).toEqual({ ...p, sessionId: SESSION, missingSignals: ['funding'], latencyMs: 420 })
  })

  it('actualiza lo que cambia con la posición abierta sin tocar lo que la identifica', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('pos-1'))
    await repo.upsertOpen(
      SESSION,
      position('pos-1', { stopPrice: 125.5, trailingActive: true, bestPrice: 129, feesPaid: 0.2, entryPrice: 999, side: 'short' }),
    )
    const [abierta] = await repo.listOpen(SESSION)
    expect(abierta).toMatchObject({ stopPrice: 125.5, trailingActive: true, bestPrice: 129, feesPaid: 0.2 })
    expect(abierta).toMatchObject({ entryPrice: 125, side: 'long' })
  })

  it('separa la cartera sombra de la real', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('real'))
    await repo.upsertOpen(SESSION, position('sombra', { shadow: true }))
    expect((await repo.listOpen(SESSION)).map((p) => p.id)).toEqual(['real'])
    expect((await repo.listOpen(SESSION, { shadow: true })).map((p) => p.id)).toEqual(['sombra'])
  })
})

describe('positionsRepo.close', () => {
  it('cierra una abierta, que deja de figurar abierta, y es idempotente', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('pos-1'))
    expect(await repo.close(SESSION, closed('pos-1'), 'Cerré SOL en el take profit.')).toBe(true)
    expect(await repo.close(SESSION, closed('pos-1', { exitPrice: 1 }), 'otra vez')).toBe(false)
    expect(await repo.listOpen(SESSION)).toEqual([])
    const { items } = await repo.listClosed(SESSION)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ ...closed('pos-1'), closePhrase: 'Cerré SOL en el take profit.' })
  })

  it('una actualización atrasada nunca reabre una cerrada', async () => {
    const repo = createPositionsRepo(db)
    await repo.close(SESSION, closed('pos-1'), 'Cerré SOL.')
    expect(await repo.upsertOpen(SESSION, position('pos-1', { stopPrice: 1 }))).toBe(false)
    expect(await repo.listOpen(SESSION)).toEqual([])
    expect((await repo.listClosed(SESSION)).items[0]?.stopPrice).toBe(122.5)
  })
})

describe('positionsRepo.insertAdopted', () => {
  it('da de alta la abierta con su evento open, sin costos de spread ni slippage', async () => {
    const repo = createPositionsRepo(db)
    const p = position('adoptada', { openReason: 'La adopté de Binance: me caí entre la orden y el guardado.', feesPaid: 0.15 })
    expect(await repo.insertAdopted(SESSION, p)).toBe(true)
    expect((await repo.listOpen(SESSION)).map((r) => [r.id, r.openReason, r.feesPaid])).toEqual([['adoptada', p.openReason, 0.15]])
    const events = await repo.listEvents('adoptada')
    expect(events.map((e) => [e.kind, e.payload, e.at.getTime()])).toEqual([
      ['open', { price: p.entryPrice, qty: p.qty, fee: 0.15, spreadCost: 0, slippageCost: 0, adopted: true }, p.openedAt],
    ])
  })

  it('nunca pisa una fila que ya existe, ni le agrega otro evento', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('pos-1'))
    expect(await repo.insertAdopted(SESSION, position('pos-1', { stopPrice: 1 }))).toBe(false)
    expect((await repo.listOpen(SESSION))[0]).toMatchObject({ stopPrice: 122.5 })
    expect(await repo.listEvents('pos-1')).toEqual([])
  })

  it('en una sesión archivada no escribe', async () => {
    const repo = createPositionsRepo(db)
    await db.update(sessions).set({ status: 'archived' }).where(eq(sessions.id, SESSION))
    await expect(repo.insertAdopted(SESSION, position('pos-1'))).rejects.toBeInstanceOf(SessionArchivedError)
    expect(await db.select().from(positions)).toEqual([])
  })
})

describe('positionsRepo: el id de otra sesión', () => {
  it('upsertOpen y close no tocan una posición con el mismo id en otra sesión', async () => {
    const repo = createPositionsRepo(db)
    await seedSession(db, 'ses_otra', { kind: 'replay', status: 'simulando' })
    await repo.upsertOpen(SESSION, position('pos-1'))
    expect(await repo.upsertOpen('ses_otra', position('pos-1', { stopPrice: 1 }))).toBe(false)
    expect(await repo.close('ses_otra', closed('pos-1'), 'Cerré SOL.')).toBe(false)
    const [abierta] = await repo.listOpen(SESSION)
    expect(abierta).toMatchObject({ id: 'pos-1', stopPrice: 122.5 })
    expect(await repo.listOpen('ses_otra')).toEqual([])
  })
})

describe('positionsRepo: sesión archivada', () => {
  const archivar = (id: string) => db.update(sessions).set({ status: 'archived' }).where(eq(sessions.id, id))

  it('upsertOpen no da de alta una posición en una sesión archivada', async () => {
    const repo = createPositionsRepo(db)
    await archivar(SESSION)
    await expect(repo.upsertOpen(SESSION, position('pos-1'))).rejects.toBeInstanceOf(SessionArchivedError)
    expect(await db.select().from(positions)).toEqual([])
  })

  it('close tampoco escribe: la posición queda como estaba al archivar', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('pos-1'))
    await archivar(SESSION)
    await expect(repo.close(SESSION, closed('pos-1'), 'Cerré SOL.')).rejects.toBeInstanceOf(SessionArchivedError)
    await expect(repo.close(SESSION, closed('pos-2'), 'Cerré SOL.')).rejects.toBeInstanceOf(SessionArchivedError)
    expect((await repo.listOpen(SESSION)).map((p) => p.id)).toEqual(['pos-1'])
    expect((await repo.listClosed(SESSION)).items).toEqual([])
  })

  it('un ciclo que escribe mientras se archiva espera al archivo y después no escribe', async () => {
    const repo = createPositionsRepo(db)
    let locked!: () => void
    let release!: () => void
    const lockTaken = new Promise<void>((resolve) => (locked = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    // Lo mismo que hace `archive`: bloquea la fila de la sesión y la marca archivada al final.
    const archiving = db.transaction(async (tx) => {
      await tx.select().from(sessions).where(eq(sessions.id, SESSION)).for('update')
      locked()
      await gate
      await tx.update(sessions).set({ status: 'archived' }).where(eq(sessions.id, SESSION))
    })
    await lockTaken
    const write = repo.upsertOpen(SESSION, position('tarde')).then(
      () => null,
      (err: unknown) => err,
    )
    await sleep(150)
    release()
    await archiving
    expect(await write).toBeInstanceOf(SessionArchivedError)
    expect(await db.select().from(positions)).toEqual([])
  })
})

describe('positionsRepo.listClosed', () => {
  beforeEach(async () => {
    const repo = createPositionsRepo(db)
    const hora = (h: number) => Date.parse(`2026-10-31T${String(h).padStart(2, '0')}:00:00Z`)
    await repo.close(SESSION, closed('a', { closedAt: hora(10), pnlNet: 5 }), 'a')
    await repo.close(SESSION, closed('b', { closedAt: hora(11), pnlNet: -4, symbol: 'BTCUSDT', side: 'short' }), 'b')
    await repo.close(SESSION, closed('c', { closedAt: hora(12), pnlNet: -50, closeReason: 'liquidation' }), 'c')
    await repo.close(SESSION, closed('d', { closedAt: hora(13), pnlNet: 2 }), 'd')
    await repo.close(SESSION, closed('s', { closedAt: hora(14), pnlNet: 3, shadow: true }), 's')
  })

  const ids = (r: { items: { id: string }[] }) => r.items.map((p) => p.id)

  it('sin filtros: todas las reales, las más recientes primero', async () => {
    expect(ids(await createPositionsRepo(db).listClosed(SESSION))).toEqual(['d', 'c', 'b', 'a'])
  })

  it('filtra por moneda, lado, resultado, liquidadas, sombra y rango', async () => {
    const repo = createPositionsRepo(db)
    expect(ids(await repo.listClosed(SESSION, { symbol: 'BTCUSDT' }))).toEqual(['b'])
    expect(ids(await repo.listClosed(SESSION, { side: 'long' }))).toEqual(['d', 'c', 'a'])
    expect(ids(await repo.listClosed(SESSION, { result: 'won' }))).toEqual(['d', 'a'])
    expect(ids(await repo.listClosed(SESSION, { result: 'lost' }))).toEqual(['c', 'b'])
    expect(ids(await repo.listClosed(SESSION, { liquidated: true }))).toEqual(['c'])
    expect(ids(await repo.listClosed(SESSION, { liquidated: false }))).toEqual(['d', 'b', 'a'])
    expect(ids(await repo.listClosed(SESSION, { shadow: true }))).toEqual(['s'])
    const desde = Date.parse('2026-10-31T11:00:00Z')
    const hasta = Date.parse('2026-10-31T13:00:00Z')
    expect(ids(await repo.listClosed(SESSION, { from: desde, to: hasta }))).toEqual(['c', 'b'])
  })

  it('pagina y avisa si hay más', async () => {
    const repo = createPositionsRepo(db)
    const primera = await repo.listClosed(SESSION, {}, { limit: 3 })
    expect(ids(primera)).toEqual(['d', 'c', 'b'])
    expect(primera.hasMore).toBe(true)
    const segunda = await repo.listClosed(SESSION, {}, { limit: 3, offset: 3 })
    expect(ids(segunda)).toEqual(['a'])
    expect(segunda.hasMore).toBe(false)
  })
})

describe('positionsRepo.addEvent / listEvents', () => {
  it('guarda la línea de tiempo de la posición en orden', async () => {
    const repo = createPositionsRepo(db)
    await repo.upsertOpen(SESSION, position('pos-1'))
    await repo.addEvent('pos-1', { kind: 'stop_moved', payload: { from: 122.5, to: 125 }, at: Date.parse('2026-10-31T12:00:00Z') })
    await repo.addEvent('pos-1', { kind: 'open', payload: { price: 125 }, at: Date.parse('2026-10-31T10:00:00Z') })
    const eventos = await repo.listEvents('pos-1')
    expect(eventos.map((e) => e.kind)).toEqual(['open', 'stop_moved'])
    expect(eventos[1]?.payload).toEqual({ from: 122.5, to: 125 })
    expect(eventos[1]?.at.toISOString()).toBe('2026-10-31T12:00:00.000Z')
  })
})
