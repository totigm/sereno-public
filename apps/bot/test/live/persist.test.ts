import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ClosedPosition, EngineEvent } from '@sereno/core'
import { SessionArchivedError, type Db } from '@sereno/db'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { MAX_REJECTIONS, Persister } from '../../src/live/persist'
import { openTestDb, seedSession, type TestDb } from '../helpers/db'
import { fillOf, openPosition, snapshotOf } from '../helpers/engine-fixtures'

const SESSION = 'ses_t20_persist'
const ARCHIVED = 'ses_t20_persist_archived'
const AT = Date.UTC(2026, 9, 31, 12, 0, 0)

let t: TestDb

beforeAll(async () => {
  t = await openTestDb()
})

afterAll(async () => {
  await t.close()
})

beforeEach(async () => {
  // Un replay terminado: escribible y fuera del índice de "una sola activa".
  await seedSession(t, SESSION, 'replay')
  await t.repos.settings.create(SESSION, DEFAULT_SETTINGS)
  await seedSession(t, ARCHIVED, 'paper_live')
})

const sol = openPosition({ id: 'live-t20-real-SOLUSDT-1', symbol: 'SOLUSDT' })

function opened(): EngineEvent {
  return { type: 'position_opened', position: sol, fill: fillOf(sol), phrase: sol.openReason }
}

function closedEvent(position: typeof sol, phrase = 'Cerré SOL por el stop.'): EngineEvent {
  const closed: ClosedPosition = {
    ...position,
    closedAt: AT + 5,
    exitPrice: 145,
    closeReason: 'stop',
    pnlGross: -10,
    pnlNet: -10.3,
    rMultiple: -1.03,
    costs: { fees: 0.3, spread: 0, slippage: 0, funding: 0 },
  }
  return { type: 'position_closed', position: closed, fill: fillOf(position, { side: 'sell', price: 145, at: AT + 5 }), phrase }
}

function persisterFor(db: Pick<Db, 'transaction'>, sessionId = SESSION, onDiscard: (error: unknown) => void = () => undefined): Persister {
  return new Persister({ db, sessionId, onDiscard })
}

// Una base que no contesta las primeras `times` transacciones (como si estuviera caída).
function downFor(times: number): Pick<Db, 'transaction'> {
  let left = times
  return {
    transaction: ((fn: Parameters<Db['transaction']>[0]) => {
      if (left > 0) {
        left -= 1
        return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      }
      return t.db.transaction(fn)
    }) as Db['transaction'],
  }
}

async function events(positionId: string) {
  return (await t.repos.positions.listEvents(positionId)).map((e) => ({ kind: e.kind, payload: e.payload }))
}

describe('Persister', () => {
  it('escribe la posición, su apertura y los payloads exactos de stop_moved y funding', async () => {
    const persister = persisterFor(t.db)
    const moved: EngineEvent = { type: 'stop_moved', positionId: sol.id, from: 145, to: 150, at: AT + 1, phrase: 'Subí el stop de SOL a 150.' }
    const paid: EngineEvent = { type: 'funding_applied', positionId: sol.id, amount: -0.42, at: AT + 2 }
    const received: EngineEvent = { type: 'funding_applied', positionId: sol.id, amount: 0.1, at: AT + 3 }
    const after = { ...sol, stopPrice: 150, trailingActive: true, fundingPaid: 0.32 }
    await persister.write({ events: [opened(), moved, paid, received], snapshot: snapshotOf({ at: AT + 3, positions: [after] }), cycleT: sol.openedAt - 250 })

    expect(await events(sol.id)).toEqual([
      { kind: 'open', payload: { price: 150, qty: 2, fee: 0.15, spreadCost: 0.02, slippageCost: 0.03 } },
      { kind: 'stop_moved', payload: { from: 145, to: 150, phrase: 'Subí el stop de SOL a 150.' } },
      { kind: 'funding', payload: { amount: 0.42 } },
      { kind: 'funding', payload: { amount: -0.1 } },
    ])
    const [row] = await t.repos.positions.listOpen(SESSION)
    expect(row).toMatchObject({ id: sol.id, stopPrice: 150, trailingActive: true, fundingPaid: 0.32, latencyMs: 250 })
    expect(await t.repos.equity.series(SESSION, 0, AT + 10)).toHaveLength(1)
  })

  it('en la sesión real los números de Binance quedan marcados como informados', async () => {
    const persister = new Persister({ db: t.db, sessionId: SESSION, onDiscard: () => undefined, fundingReported: true })
    const open: EngineEvent = { type: 'position_opened', position: sol, fill: { ...fillOf(sol), reported: true }, phrase: sol.openReason }
    const paid: EngineEvent = { type: 'funding_applied', positionId: sol.id, amount: -0.42, at: AT + 2 }
    const closing = closedEvent(sol)
    const close: EngineEvent = closing.type === 'position_closed' ? { ...closing, fill: { ...closing.fill, reported: true } } : closing
    await persister.write({ events: [open, paid, close], snapshot: snapshotOf({ at: AT + 5, positions: [] }) })
    expect((await events(sol.id)).map((e) => ({ kind: e.kind, reported: e.payload.reported }))).toEqual([
      { kind: 'open', reported: true },
      { kind: 'funding', reported: true },
      { kind: 'close', reported: true },
    ])
  })

  it('el drawdown de lo real pausa la sesión con el motivo, en la misma transacción que el evento', async () => {
    const persister = persisterFor(t.db)
    const drawdown: EngineEvent = { type: 'account_rule', at: AT, rule: 'drawdown', phrase: 'Me pausé: el capital cayó 15 % desde su pico.' }
    // Un evento de una posición que no existe rompe el lote: la pausa no queda escrita.
    const broken: EngineEvent = { type: 'stop_moved', positionId: 'no-existe', from: 1, to: 2, at: AT, phrase: 'x' }
    await expect(persister.write({ events: [drawdown, broken], snapshot: snapshotOf({ at: AT }) })).rejects.toThrow()
    expect((await t.repos.settings.get(SESSION))?.config.pause.paused).toBe(false)

    const retry = persisterFor(t.db)
    await retry.write({ events: [drawdown], snapshot: snapshotOf({ at: AT }) })
    const row = await t.repos.settings.get(SESSION)
    expect(row?.version).toBe(2)
    expect(row?.config.pause).toEqual({ paused: true, by: 'auto', at: new Date(AT).toISOString(), reason: 'Me pausé: el capital cayó 15 % desde su pico.' })
  })

  it('el capital blindado sin margen también pausa; el drawdown de la sombra nunca', async () => {
    const persister = persisterFor(t.db)
    const shadow: EngineEvent = { type: 'account_rule', at: AT, rule: 'drawdown', phrase: 'La sombra cayó 15 %.', shadow: true }
    await persister.write({ events: [shadow], snapshot: snapshotOf({ at: AT }) })
    expect((await t.repos.settings.get(SESSION))?.config.pause.paused).toBe(false)

    const shortfall: EngineEvent = { type: 'account_rule', at: AT + 1, rule: 'shield_insufficient', phrase: 'Me pausé: lo que queda sin blindar no alcanza.' }
    await persister.write({ events: [shortfall], snapshot: snapshotOf({ at: AT + 1 }) })
    expect((await t.repos.settings.get(SESSION))?.config.pause).toMatchObject({ paused: true, by: 'auto', reason: 'Me pausé: lo que queda sin blindar no alcanza.' })
  })

  it('un lote que falla se reintenta con el siguiente', async () => {
    let failNext = true
    const flaky: Pick<Db, 'transaction'> = {
      transaction: ((fn: Parameters<Db['transaction']>[0]) => {
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('conexión perdida'))
        }
        return t.db.transaction(fn)
      }) as Db['transaction'],
    }
    const persister = persisterFor(flaky)
    await expect(persister.write({ events: [opened()], snapshot: snapshotOf({ at: AT, positions: [sol] }) })).rejects.toThrow('conexión perdida')
    expect(persister.pendingRetries).toBe(1)
    await persister.write({ events: [], snapshot: snapshotOf({ at: AT + 1, positions: [sol] }), minute: true })
    expect(await events(sol.id)).toEqual([expect.objectContaining({ kind: 'open' })])
    expect(persister.pendingRetries).toBe(0)
  })

  it('un lote que la base rechaza tres veces se descarta y avisa: los siguientes se escriben', async () => {
    const discarded: unknown[] = []
    const persister = persisterFor(t.db, SESSION, (error) => discarded.push(error))
    const broken: EngineEvent = { type: 'stop_moved', positionId: 'no-existe', from: 1, to: 2, at: AT, phrase: 'x' }
    await expect(persister.write({ events: [broken], snapshot: snapshotOf({ at: AT }) })).rejects.toThrow()
    for (let i = 1; i < MAX_REJECTIONS - 1; i++) {
      await expect(persister.write({ events: [], snapshot: snapshotOf({ at: AT + i }), minute: true })).rejects.toThrow()
    }
    expect(discarded).toEqual([])
    await persister.write({ events: [opened()], snapshot: snapshotOf({ at: AT + 10, positions: [sol] }), minute: true })
    expect(discarded).toHaveLength(1)
    expect(persister.pendingRetries).toBe(0)
    expect(await events(sol.id)).toEqual([expect.objectContaining({ kind: 'open' })])
    // Los puntos por minuto de los lotes que esperaban detrás del roto también quedaron.
    expect((await t.repos.equity.series(SESSION, 0, AT + 100)).map((p) => [p.at, p.kind])).toEqual([
      [AT + 1, 'minute'],
      [AT + 10, 'event'],
      [AT + 10, 'minute'],
    ])
  })

  it('un lote descartado con un cierre no deja la posición abierta en la base: el cierre se escribe solo después', async () => {
    const discarded: unknown[] = []
    const persister = persisterFor(t.db, SESSION, (error) => discarded.push(error))
    await persister.write({ events: [opened()], snapshot: snapshotOf({ at: AT, positions: [sol] }) })
    // El cierre viene con un evento que rompe el lote: el lote entero se descarta.
    const broken: EngineEvent = { type: 'stop_moved', positionId: 'no-existe', from: 1, to: 2, at: AT, phrase: 'x' }
    await expect(persister.write({ events: [closedEvent(sol), broken], snapshot: snapshotOf({ at: AT + 5 }) })).rejects.toThrow()
    for (let i = 1; i < MAX_REJECTIONS - 1; i++) {
      await expect(persister.write({ events: [], snapshot: snapshotOf({ at: AT + 5 + i }), minute: true })).rejects.toThrow()
    }
    await persister.write({ events: [], snapshot: snapshotOf({ at: AT + 10 }), minute: true })
    expect(discarded).toHaveLength(1)
    expect(persister.pendingCloses).toBe(0)
    expect(await t.repos.positions.listOpen(SESSION)).toEqual([])
    const [row] = (await t.repos.positions.listClosed(SESSION)).items
    expect(row).toMatchObject({ id: sol.id, closeReason: 'stop', exitPrice: 145, pnlNet: -10.3 })
    expect((await events(sol.id)).map((e) => e.kind)).toEqual(['open', 'close'])
  })

  it('si la base tampoco acepta el cierre solo, avisa qué posición quedó abierta', async () => {
    const discarded: unknown[] = []
    const stuck: string[] = []
    const persister = new Persister({ db: t.db, sessionId: SESSION, onDiscard: (error) => discarded.push(error), onStuckOpen: (id) => stuck.push(id) })
    await persister.write({ events: [opened()], snapshot: snapshotOf({ at: AT, positions: [sol] }) })
    // Postgres no acepta el carácter nulo en un texto: el cierre mismo es lo que la base rechaza.
    await expect(persister.write({ events: [closedEvent(sol, 'Cerré SOL\u0000')], snapshot: snapshotOf({ at: AT + 5 }) })).rejects.toThrow()
    for (let i = 1; i < MAX_REJECTIONS - 1; i++) {
      await expect(persister.write({ events: [], snapshot: snapshotOf({ at: AT + 5 + i }), minute: true })).rejects.toThrow()
    }
    // El lote del cierre se descarta; los que siguen se escriben y reintentan el cierre solo.
    for (let i = 0; i < MAX_REJECTIONS; i++) await persister.write({ events: [], snapshot: snapshotOf({ at: AT + 10 + i }), minute: true })
    expect(discarded).toHaveLength(1)
    expect(stuck).toEqual([sol.id])
    expect(persister.pendingCloses).toBe(0)
    expect((await t.repos.positions.listOpen(SESSION)).map((p) => p.id)).toEqual([sol.id])
  })

  it('con la base caída no descarta nada: al volver escribe todo en orden con el último estado', async () => {
    const persister = persisterFor(downFor(3))
    const moved = { ...sol, stopPrice: 148 }
    const batches = [
      { events: [opened()], snapshot: snapshotOf({ at: AT, positions: [sol] }) },
      { events: [], snapshot: snapshotOf({ at: AT + 60_000, positions: [{ ...sol, stopPrice: 147 }] }), minute: true },
      { events: [], snapshot: snapshotOf({ at: AT + 120_000, positions: [moved] }), minute: true },
    ]
    for (const batch of batches) await expect(persister.write(batch)).rejects.toThrow('ECONNREFUSED')
    expect(persister.pendingRetries).toBe(3)
    await persister.write({ events: [], snapshot: snapshotOf({ at: AT + 180_000, positions: [moved] }), minute: true })
    expect(persister.pendingRetries).toBe(0)
    expect((await t.repos.positions.listOpen(SESSION)).map((p) => p.stopPrice)).toEqual([148])
    expect((await t.repos.equity.series(SESSION, 0, AT + 200_000)).map((p) => [p.at, p.kind])).toEqual([
      [AT, 'event'],
      [AT + 60_000, 'minute'],
      [AT + 120_000, 'minute'],
      [AT + 180_000, 'minute'],
    ])
  })

  it('con la sesión archivada no escribe nada y avisa', async () => {
    const persister = persisterFor(t.db, ARCHIVED)
    const decisions: EngineEvent = { type: 'decisions', t: AT, decisions: [] }
    await expect(persister.write({ events: [decisions], snapshot: snapshotOf({ at: AT }), minute: true })).rejects.toBeInstanceOf(SessionArchivedError)
    expect(await t.repos.equity.series(ARCHIVED, 0, AT + 10)).toHaveLength(0)
    await expect(persister.write({ events: [], snapshot: snapshotOf({ at: AT }) })).rejects.toBeInstanceOf(SessionArchivedError)
  })
})
