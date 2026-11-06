import { eq, getTableName, sql } from 'drizzle-orm'
import {
  botCommands,
  botLease,
  botStatus,
  candles,
  createRepos,
  decisions,
  equitySnapshots,
  futuresData,
  learningLog,
  learningState,
  marketSnapshot,
  positionEvents,
  positions,
  realEvents,
  realReadiness,
  sessions,
  settings,
  settingsHistory,
  symbols,
  universeDays,
  type AnyDb,
  type Db,
  type ForwardReturnUpdate,
} from '@sereno/db'
import { decisionKey, type DemoDataset, type DemoSession } from './dataset'

// Vuelca un escenario en la base, en una transacción: o queda el escenario entero o
// queda lo que había. Borra todo menos las tablas de Better Auth (el usuario de
// `seed:user` sobrevive). Los repos se usan donde respetan los instantes dados; las
// filas que el repo sella con `now()` (sesión, ajustes, latido, snapshot) van
// directo a la tabla, porque el escenario trae su propio reloj.

export const DATA_TABLES = [
  positionEvents,
  positions,
  decisions,
  equitySnapshots,
  marketSnapshot,
  learningLog,
  learningState,
  settingsHistory,
  settings,
  universeDays,
  botLease,
  botStatus,
  botCommands,
  realEvents,
  realReadiness,
  candles,
  futuresData,
  symbols,
  sessions,
]

export interface WriteSummary {
  sessions: number
  positions: number
  decisions: number
  equityPoints: number
  candles: number
}

async function wipe(db: Db): Promise<void> {
  const names = DATA_TABLES.map((t) => sql.identifier(getTableName(t)))
  await db.execute(sql`truncate table ${sql.join(names, sql`, `)} restart identity cascade`)
}

async function writeSession(db: Db, s: DemoSession): Promise<{ positions: number; decisions: number }> {
  const repos = createRepos(db)
  const id = s.row.id
  if (!id) throw new Error('Una sesión de demostración sin id')
  await db.insert(sessions).values(s.row)

  const current = s.settings[s.settings.length - 1]
  if (current) {
    await db.insert(settings).values({ sessionId: id, config: current.config, version: current.version, updatedAt: new Date(current.at), updatedBy: current.by })
    await db.insert(settingsHistory).values(s.settings.map((v) => ({ sessionId: id, version: v.version, config: v.config, changedBy: v.by, changedAt: new Date(v.at) })))
  }
  if (s.universe.length > 0) {
    await db.insert(universeDays).values(s.universe.map((u) => ({ sessionId: id, day: u.day, symbols: u.symbols, createdAt: new Date(`${u.day}T00:00:05Z`) })))
  }

  let positionCount = 0
  for (const book of s.books ? [s.books.real, s.books.shadow] : []) {
    for (const p of book.positions) {
      const opts = { latencyMs: p.latencyMs }
      if (p.closed) await repos.positions.close(id, p.closed, p.closePhrase ?? '', opts)
      else await repos.positions.upsertOpen(id, p.position, opts)
      for (const event of p.events) await repos.positions.addEvent(p.position.id, event)
      positionCount++
    }
  }

  if (s.decisions.length > 0) {
    await repos.decisions.insertBatch(id, s.decisions)
    // Los retornos van por id, como los rellena el job del bot. Un replay guarda
    // ~100.000 decisiones: sólo se leen las claves, no las señales.
    const stored = await db
      .select({ id: decisions.id, symbol: decisions.symbol, candleCloseTime: decisions.candleCloseTime })
      .from(decisions)
      .where(eq(decisions.sessionId, id))
    const updates: ForwardReturnUpdate[] = []
    for (const row of stored) {
      const fr = s.forwardReturns.get(decisionKey(row.symbol, row.candleCloseTime.getTime()))
      if (fr) updates.push({ id: row.id, ...fr })
    }
    await repos.decisions.fillForwardReturns(updates)
  }

  if (s.equity.length > 0) await repos.equity.insert(id, s.equity)
  if (s.marketSnapshot) {
    const { updatedAt, version, symbols: views } = s.marketSnapshot
    await db.insert(marketSnapshot).values({ sessionId: id, updatedAt: new Date(updatedAt), version, symbols: views })
  }
  if (s.bot) {
    await db.insert(botStatus).values(s.bot.status)
    await db.insert(botLease).values(s.bot.lease)
  }
  if (s.realEvents) await repos.realEvents.append(id, s.realEvents)
  if (s.learning) {
    await repos.learning.save(id, s.learning.state)
    if (s.learning.log.length > 0) await repos.learning.appendLog(id, s.learning.log)
    const lastChange = s.learning.log[s.learning.log.length - 1]?.at
    if (lastChange !== undefined) await db.update(learningState).set({ updatedAt: new Date(lastChange) }).where(eq(learningState.sessionId, id))
  }
  return { positions: positionCount, decisions: s.decisions.length }
}

export async function writeDataset(db: AnyDb, dataset: DemoDataset): Promise<WriteSummary> {
  return (db as Db).transaction(async (tx) => {
    await wipe(tx)
    const repos = createRepos(tx)
    if (dataset.symbols.length > 0) {
      await repos.symbols.upsertMany(dataset.symbols.map((s) => s.row))
      for (const s of dataset.symbols) await repos.symbols.setObservedSpread(s.row.symbol, s.observedSpread)
      await tx.update(symbols).set({ updatedAt: new Date(dataset.now) })
    }
    if (dataset.readiness) {
      const { checkedAt, ...row } = dataset.readiness
      await tx.insert(realReadiness).values({ ...row, checkedAt: new Date(checkedAt) })
    }
    let candleCount = 0
    for (const { key, items } of dataset.candles) {
      await repos.candles.upsertMany(key, items)
      candleCount += items.length
    }
    const summary: WriteSummary = { sessions: 0, positions: 0, decisions: 0, equityPoints: 0, candles: candleCount }
    for (const s of dataset.sessions) {
      const written = await writeSession(tx, s)
      summary.sessions++
      summary.positions += written.positions
      summary.decisions += written.decisions
      summary.equityPoints += s.equity.length
    }
    return summary
  })
}
