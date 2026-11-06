import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { journalLine } from '@/components/resumen/journal-text'
import { loadJournal } from '@/lib/queries/journal'
import { dropSessions, openTestDb, SEEDING_STATUS, seedSession, testSessionId, type TestDb } from '../db'
import { closedPosition } from '../fixtures'

// El diario de la sesión real (spec real §Dashboard): dice qué números vienen de Binance
// y cuándo hubo una diferencia de reconciliación. La de papel no cambia.

const REAL = testSessionId('journal_real')
const PAPER = testSessionId('journal_paper')
const HOUR = 3_600_000
const RECONCILED = 'Binance cerró el short en ETH y la base lo tenía abierto: lo registré con el fill real.'
let t: TestDb
let now: number

async function seedClose(sessionId: string, id: string, reported: boolean): Promise<void> {
  const closed = closedPosition(id, { symbol: 'BTCUSDT', openedAt: now - 3 * HOUR, closedAt: now - HOUR, pnlNet: 1.2, rMultiple: 0.8 })
  await t.repos.positions.upsertOpen(sessionId, closed)
  await t.repos.positions.addEvent(id, { kind: 'open', payload: { price: 125, qty: 2, fee: 0.1, ...(reported ? { reported: true } : {}) }, at: closed.openedAt })
  await t.repos.positions.close(sessionId, closed, 'Cerré el long en BTC en el take profit: +US$ 1,20 (+0,8R).')
  await t.repos.positions.addEvent(id, { kind: 'close', payload: { price: 130, qty: 2, fee: 0.1, ...(reported ? { reported: true } : {}) }, at: closed.closedAt })
}

beforeAll(async () => {
  t = await openTestDb()
  now = Date.now()
  await seedSession(t, REAL, { status: SEEDING_STATUS, startedAt: now - 5 * HOUR, kind: 'live', capitalInicial: 50 })
  await seedSession(t, PAPER, { status: SEEDING_STATUS, startedAt: now - 5 * HOUR })
  await seedClose(REAL, `pos_${REAL}`, true)
  await seedClose(PAPER, `pos_${PAPER}`, false)
  await t.repos.realEvents.append(REAL, [
    { at: now - 2 * HOUR, kind: 'reconciled', symbol: 'ETHUSDT', phrase: RECONCILED },
    { at: now - 30 * 60_000, kind: 'off', phrase: 'Me apagaste: cerré todo y dejé de operar con plata real.' },
  ])
})

afterAll(async () => {
  await dropSessions(t, [REAL, PAPER])
  await t.db.$client.end()
})

describe('diario de la sesión real', () => {
  it('las entradas con números de Binance lo dicen y las diferencias van destacadas', async () => {
    const journal = await loadJournal(t.db, t.repos, { sessionId: REAL, anchor: now, theta: 0.35, real: true })
    const close = journal.entries.find((e) => e.kind === 'close')
    expect(close).toMatchObject({ reported: true })
    expect(close && journalLine(close)).toBe('Cerré el long en BTC en el take profit: +US$ 1,20 (+0,8R) · datos de Binance')
    expect(journal.entries.find((e) => e.kind === 'open')).toMatchObject({ reported: true })

    const real = journal.entries.filter((e) => e.kind === 'real')
    expect(real.map((e) => [e.text, e.highlight, e.symbol])).toEqual([
      ['Me apagaste: cerré todo y dejé de operar con plata real.', false, null],
      [RECONCILED, true, 'ETHUSDT'],
    ])
  })

  it('una sesión de papel no cambia', async () => {
    const journal = await loadJournal(t.db, t.repos, { sessionId: PAPER, anchor: now, theta: 0.35, real: false })
    expect(journal.entries.some((e) => e.reported || e.kind === 'real')).toBe(false)
    const close = journal.entries.find((e) => e.kind === 'close')
    expect(close && journalLine(close)).toBe('Cerré el long en BTC en el take profit: +US$ 1,20 (+0,8R).')
  })
})
