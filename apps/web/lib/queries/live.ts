import type { BotStatusRow, CommandRow, EquityRecord, MarketSnapshotRow } from '@sereno/db'
import { startOfDayBA } from '@sereno/shared'
import { db, repos } from '../db'
import { isOffline, marksOf, valuePosition } from '../derive'
import type { BotStatusView, CommandView, EquityView, LiveResponse, MarketSnapshotView } from '../live/types'
import { equityAt } from './sql/equity'
import { readLedgerTotals, saldoOf } from './sql/ledger'
import { readLiveVersion, versionToken } from './sql/live-version'

/** Cuántos comandos recientes viajan en vivo (los de la última acción y los que todavía esperan). */
const RECENT_COMMANDS = 10

/**
 * Lo que muestra `/api/live` (spec §11.5). Con `since` igual a la versión vigente
 * contesta `{ unchanged: true }` después de una sola consulta. Null si la sesión no existe.
 */
export async function loadLive(sessionId: string, since?: string): Promise<LiveResponse | null> {
  const head = await readLiveVersion(db, sessionId)
  if (!head) return null
  const { now } = head
  const offline = isOffline(head.heartbeat, now)
  const dayStart = startOfDayBA(now)
  const version = versionToken(head, offline, dayStart)
  if (since === version) return { unchanged: true }

  const [market, open, bot, equityLast, settings, totals, dayStartPoint, commands] = await Promise.all([
    repos.market.get(sessionId),
    repos.positions.listOpen(sessionId),
    repos.bot.get(sessionId),
    repos.equity.latest(sessionId),
    repos.settings.get(sessionId),
    readLedgerTotals(db, sessionId),
    head.startedAt >= dayStart ? null : equityAt(db, sessionId, dayStart),
    repos.commands.listRecent(sessionId, RECENT_COMMANDS),
  ])
  const marketView = market ? toMarketView(market) : null
  const marks = marksOf(marketView)

  return {
    version,
    sessionId,
    now,
    offline,
    market: marketView,
    open: open.map((p) => ({ ...p, valuation: valuePosition(p, marks) })),
    botStatus: bot ? toBotStatusView(bot) : null,
    equityLast: equityLast ? toEquityView(equityLast) : null,
    settingsVersion: settings?.version ?? null,
    settings: settings?.config ?? null,
    ledger: {
      capitalInicial: head.capitalInicial,
      startedAt: head.startedAt,
      saldo: saldoOf(head.capitalInicial, totals),
      protegido: head.protegido,
      baseBlindaje: head.baseBlindaje,
      closedCount: totals.closedCount,
      wonCount: totals.wonCount,
      dayStart,
      // Sin un punto antes de las 00:00 el bot no operó antes: la equity era I₀.
      equityAtDayStart: dayStartPoint?.equity ?? head.capitalInicial,
    },
    commands: commands.map((c) => toCommandView(c, now)),
    realStatus: head.realStatus,
  }
}

function toMarketView(row: MarketSnapshotRow): MarketSnapshotView {
  return { version: row.version, updatedAt: row.updatedAt.getTime(), symbols: row.symbols }
}

function toBotStatusView(row: BotStatusRow): BotStatusView {
  return {
    instanceId: row.instanceId,
    lastHeartbeat: row.lastHeartbeat.getTime(),
    phase: row.phase,
    warmProgress: row.warmProgress,
    universeSize: row.universeSize,
    lastCycleAt: row.lastCycleAt?.getTime() ?? null,
    settingsVersionApplied: row.settingsVersionApplied,
    degradedSymbols: row.degradedSymbols,
    flags: row.flags,
    recentErrors: row.recentErrors,
    botVersion: row.botVersion,
    real: row.real,
  }
}

export function toEquityView(r: EquityRecord): EquityView {
  return {
    id: r.id,
    at: r.at,
    saldo: r.saldo,
    equity: r.equity,
    margenEnUso: r.margenEnUso,
    protegido: r.protegido,
    capitalBase: r.capitalBase,
    capitalOperable: r.capitalOperable,
    shadowEquity: r.shadowEquity,
    kind: r.kind,
  }
}

export function toCommandView(row: CommandRow, now: number): CommandView {
  const expiresAt = row.expiresAt?.getTime() ?? null
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    createdAt: row.createdAt.getTime(),
    expiresAt,
    claimedAt: row.claimedAt?.getTime() ?? null,
    finishedAt: row.finishedAt?.getTime() ?? null,
    result: row.result,
    requestedBy: row.requestedBy,
    expired: row.status === 'expired' || (row.status === 'pending' && expiresAt !== null && expiresAt <= now),
  }
}
