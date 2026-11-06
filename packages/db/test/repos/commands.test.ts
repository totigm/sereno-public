import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CommandInput } from '@sereno/shared'
import type { DirectDb } from '../../src/client'
import { createCommandsRepo } from '../../src/repos/commands'
import { botCommands, sessions } from '../../src/schema'
import { openTestDb, seedSession, truncate } from './helpers'

const SESSION = 'ses_cmd'
const UUID_A = '6f1c2a9e-3b4d-4c5e-8f6a-7b8c9d0e1f2a'
const UUID_B = '0b7d5e3c-9a1f-4e2d-b6c8-1d2e3f4a5b6c'

function closeAll(id: string): CommandInput {
  return { id, sessionId: SESSION, kind: 'close_all', requestedBy: 'toti@example.com' }
}

function resetLearning(id: string): CommandInput {
  return { id, sessionId: SESSION, kind: 'reset_learning', payload: {}, requestedBy: 'toti@example.com' }
}

function closePosition(id: string, symbol = 'BTCUSDT'): CommandInput {
  return { id, sessionId: SESSION, kind: 'close_position', payload: { symbol }, requestedBy: 'toti@example.com' }
}

function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

// Dos clientes con una conexión cada uno: así los claims concurrentes corren de
// verdad en dos conexiones distintas y no en una sola serializada.
let dbA: DirectDb
let dbB: DirectDb

beforeAll(async () => {
  dbA = await openTestDb(1)
  dbB = await openTestDb(1)
})

afterAll(async () => {
  await dbA.$client.end()
  await dbB.$client.end()
})

beforeEach(async () => {
  await truncate(dbA, sessions, botCommands)
  await seedSession(dbA, SESSION)
})

async function rows() {
  return new Map((await dbA.select().from(botCommands)).map((f) => [f.id, f]))
}

// Corre un comando hacia atrás en el tiempo: lo deja vencido sin esperar 60 s.
async function backdate(id: string, seconds: number): Promise<void> {
  const shift = sql.raw(`interval '${seconds} seconds'`)
  await dbA
    .update(botCommands)
    .set({
      createdAt: sql`${botCommands.createdAt} - ${shift}`,
      expiresAt: sql`${botCommands.expiresAt} - ${shift}`,
    })
    .where(eq(botCommands.id, id))
}

describe('commandsRepo.enqueue', () => {
  it('con el mismo uuid dos veces inserta una sola fila (ON CONFLICT DO NOTHING)', async () => {
    const repo = createCommandsRepo(dbA)
    expect(await repo.enqueue(closeAll(UUID_A))).toBe(true)
    expect(await repo.enqueue(closeAll(UUID_A))).toBe(false)
    const filas = await dbA.select().from(botCommands)
    expect(filas).toHaveLength(1)
    expect(filas[0]?.status).toBe('pending')
    // Sin payload el comando igual queda con `{}`.
    expect(filas[0]?.payload).toEqual({})
  })

  it('los sensibles al precio vencen a los 60 s de creados; el resto no vence', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closePosition(UUID_A))
    await repo.enqueue(resetLearning(UUID_B))
    const porId = await rows()
    const a = porId.get(UUID_A)
    expect(a?.payload).toEqual({ symbol: 'BTCUSDT' })
    expect((a?.expiresAt?.getTime() ?? 0) - (a?.createdAt.getTime() ?? 0)).toBe(60_000)
    expect(porId.get(UUID_B)?.expiresAt).toBeNull()
  })

  it('rechaza un comando que no valida sin escribir', async () => {
    const repo = createCommandsRepo(dbA)
    await expect(repo.enqueue({ ...closePosition(UUID_A), requestedBy: 'no-es-un-email' })).rejects.toThrow()
    expect(await dbA.select().from(botCommands)).toHaveLength(0)
  })
})

describe('commandsRepo.claimNext', () => {
  it('dos claims concurrentes del mismo comando: uno lo recibe y el otro null', async () => {
    await createCommandsRepo(dbA).enqueue(closeAll(UUID_A))
    const [a, b] = await Promise.all([
      createCommandsRepo(dbA).claimNext(SESSION, 'bot-a'),
      createCommandsRepo(dbB).claimNext(SESSION, 'bot-b'),
    ])
    const ganadores = [a, b].filter((c) => c !== null)
    expect(ganadores).toHaveLength(1)
    const ganador = ganadores[0]
    expect(ganador?.id).toBe(UUID_A)
    expect(ganador?.status).toBe('claimed')
    expect(ganador?.claimedAt).toBeInstanceOf(Date)
    expect(['bot-a', 'bot-b']).toContain(ganador?.claimedBy)
    // La base quedó con esa única fila, reclamada por el mismo bot.
    const [fila] = await dbA.select().from(botCommands)
    expect(fila?.status).toBe('claimed')
    expect(fila?.claimedBy).toBe(ganador?.claimedBy)
  })

  it('dos bots reclamando en paralelo una cola de 20 nunca reciben el mismo comando', async () => {
    const repo = createCommandsRepo(dbA)
    for (let i = 0; i < 20; i++) await repo.enqueue(closeAll(uuid(i)))
    const drain = async (db: DirectDb, bot: string): Promise<string[]> => {
      const got: string[] = []
      const r = createCommandsRepo(db)
      for (let c = await r.claimNext(SESSION, bot); c !== null; c = await r.claimNext(SESSION, bot)) got.push(c.id)
      return got
    }
    const [deA, deB] = await Promise.all([drain(dbA, 'bot-a'), drain(dbB, 'bot-b')])
    const todos = [...deA, ...deB]
    expect(todos).toHaveLength(20)
    expect(new Set(todos).size).toBe(20)
    const porId = await rows()
    for (const id of deA) expect(porId.get(id)?.claimedBy).toBe('bot-a')
    for (const id of deB) expect(porId.get(id)?.claimedBy).toBe('bot-b')
  })

  it('entrega en orden de llegada y devuelve null cuando no queda nada', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closeAll(UUID_B))
    await repo.enqueue(closeAll(UUID_A))
    // B se pidió antes que A.
    await backdate(UUID_B, 5)
    expect((await repo.claimNext(SESSION, 'bot-a'))?.id).toBe(UUID_B)
    expect((await repo.claimNext(SESSION, 'bot-a'))?.id).toBe(UUID_A)
    expect(await repo.claimNext(SESSION, 'bot-a')).toBeNull()
  })

  it('no entrega un comando vencido aunque siga pending', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closePosition(UUID_A))
    await backdate(UUID_A, 120)
    expect(await repo.claimNext(SESSION, 'bot-a')).toBeNull()
    expect((await rows()).get(UUID_A)?.status).toBe('pending')
  })

  it('no entrega comandos de otra sesión', async () => {
    await seedSession(dbA, 'ses_otra')
    const repo = createCommandsRepo(dbA)
    await repo.enqueue({ ...closeAll(UUID_A), sessionId: 'ses_otra' })
    expect(await repo.claimNext(SESSION, 'bot-a')).toBeNull()
  })
})

describe('commandsRepo.expireStale', () => {
  it('un comando con expires_at pasado queda expired y claimNext no lo devuelve', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closePosition(UUID_A))
    await repo.enqueue(resetLearning(UUID_B))
    await backdate(UUID_A, 120)
    await backdate(UUID_B, 120)
    expect(await repo.expireStale(SESSION)).toBe(1)
    expect(await repo.expireStale(SESSION)).toBe(0)
    const porId = await rows()
    expect(porId.get(UUID_A)?.status).toBe('expired')
    expect(porId.get(UUID_A)?.finishedAt).toBeInstanceOf(Date)
    // El que no vence sigue en la cola por más viejo que sea.
    expect(porId.get(UUID_B)?.status).toBe('pending')
    expect((await repo.claimNext(SESSION, 'bot-a'))?.id).toBe(UUID_B)
    expect(await repo.claimNext(SESSION, 'bot-a')).toBeNull()
  })

  it('no toca comandos vencidos de otra sesión', async () => {
    await seedSession(dbA, 'ses_otra')
    const repo = createCommandsRepo(dbA)
    await repo.enqueue({ ...closePosition(UUID_A), sessionId: 'ses_otra' })
    await backdate(UUID_A, 120)
    expect(await repo.expireStale(SESSION)).toBe(0)
    expect((await rows()).get(UUID_A)?.status).toBe('pending')
  })
})

describe('commandsRepo.finish / cancel / listRecent', () => {
  it('finish con resultado queda done; con error queda failed; sólo sobre reclamados', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closeAll(UUID_A))
    await repo.enqueue(closeAll(UUID_B))
    await backdate(UUID_A, 1)
    expect(await repo.finish(UUID_A, { ok: true, message: 'antes de reclamar' })).toBe(false)
    await repo.claimNext(SESSION, 'bot-a')
    await repo.claimNext(SESSION, 'bot-a')
    expect(await repo.finish(UUID_A, { ok: true, message: 'Cerré 2 posiciones', data: { closed: 2 } })).toBe(true)
    expect(await repo.finish(UUID_B, new Error('Binance no respondió'))).toBe(true)
    // Terminado no se vuelve a terminar.
    expect(await repo.finish(UUID_A, { ok: false, message: 'otra vez' })).toBe(false)
    const porId = await rows()
    expect(porId.get(UUID_A)).toMatchObject({
      status: 'done',
      result: { ok: true, message: 'Cerré 2 posiciones', data: { closed: 2 } },
    })
    expect(porId.get(UUID_A)?.finishedAt).toBeInstanceOf(Date)
    expect(porId.get(UUID_B)).toMatchObject({ status: 'failed', result: { ok: false, message: 'Binance no respondió' } })
  })

  it('finish con ok: false queda failed', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closePosition(UUID_A, 'SOLUSDT'))
    await repo.claimNext(SESSION, 'bot-a')
    await repo.finish(UUID_A, { ok: false, message: 'No hay posición abierta en SOLUSDT' })
    expect((await rows()).get(UUID_A)?.status).toBe('failed')
  })

  it('cancel sólo cancela los pending', async () => {
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closeAll(UUID_A))
    await repo.enqueue(closeAll(UUID_B))
    await backdate(UUID_A, 1)
    await repo.claimNext(SESSION, 'bot-a')
    expect(await repo.cancel(UUID_A, SESSION)).toBe('not_pending')
    expect(await repo.cancel(UUID_B, SESSION)).toBe('cancelled')
    expect(await repo.cancel(UUID_B, SESSION)).toBe('not_pending')
    expect((await rows()).get(UUID_B)?.status).toBe('cancelled')
    expect(await repo.claimNext(SESSION, 'bot-a')).toBeNull()
  })

  it('cancel no toca un comando de otra sesión y dice por qué no lo canceló', async () => {
    await seedSession(dbA, 'ses_otra')
    const repo = createCommandsRepo(dbA)
    await repo.enqueue({ ...closeAll(UUID_A), sessionId: 'ses_otra' })
    expect(await repo.cancel(UUID_A, SESSION)).toBe('other_session')
    expect((await rows()).get(UUID_A)?.status).toBe('pending')
    expect(await repo.cancel(UUID_B, SESSION)).toBe('not_found')
  })

  it('listRecent devuelve los últimos primero, de la sesión pedida, y respeta el límite', async () => {
    await seedSession(dbA, 'ses_otra')
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(closeAll(UUID_A))
    await repo.enqueue(closeAll(UUID_B))
    await repo.enqueue({ ...closeAll(uuid(1)), sessionId: 'ses_otra' })
    await backdate(UUID_A, 1)
    expect((await repo.listRecent(SESSION)).map((c) => c.id)).toEqual([UUID_B, UUID_A])
    expect((await repo.listRecent(SESSION, 1)).map((c) => c.id)).toEqual([UUID_B])
  })
})

describe('commandsRepo.failStaleClaims', () => {
  it('marca failed los reclamados hace más del plazo, de esa sesión; los recientes siguen en curso', async () => {
    await seedSession(dbA, 'ses_otra')
    const repo = createCommandsRepo(dbA)
    await repo.enqueue(resetLearning(UUID_A))
    await repo.enqueue(resetLearning(UUID_B))
    await repo.enqueue({ ...resetLearning(uuid(1)), sessionId: 'ses_otra' })
    await backdate(UUID_A, 1)
    await repo.claimNext(SESSION, 'bot-caido')
    await repo.claimNext(SESSION, 'bot-caido')
    await repo.claimNext('ses_otra', 'bot-caido')
    // El de A lo tomó un bot que se cayó hace 10 minutos.
    await dbA
      .update(botCommands)
      .set({ claimedAt: sql`now() - interval '10 minutes'` })
      .where(sql`${botCommands.id} in (${UUID_A}, ${uuid(1)})`)

    expect(await repo.failStaleClaims(SESSION, 5 * 60_000)).toBe(1)
    const porId = await rows()
    expect(porId.get(UUID_A)).toMatchObject({
      status: 'failed',
      result: { ok: false, message: 'El bot se reinició antes de terminarlo. Si todavía hace falta, pedilo de nuevo.' },
    })
    expect(porId.get(UUID_A)?.finishedAt).toBeInstanceOf(Date)
    expect(porId.get(UUID_B)?.status).toBe('claimed')
    expect(porId.get(uuid(1))?.status).toBe('claimed')
    // Un bot que vuelve tarde ya no lo puede terminar.
    expect(await repo.finish(UUID_A, { ok: true, message: 'tarde' })).toBe(false)
  })
})
