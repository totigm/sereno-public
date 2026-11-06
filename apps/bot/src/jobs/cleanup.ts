// Limpieza diaria (spec §10): en las sesiones en vivo, decisiones de más de 30 días y
// equity por minuto de más de 90. Las de replay y los puntos por evento quedan siempre
// (lo filtran los repos).

import type { DecisionsRepo, EquityRepo } from '@sereno/db'
import type { Logger } from '../logger'

export const DECISIONS_RETENTION_DAYS = 30
export const MINUTE_EQUITY_RETENTION_DAYS = 90
const DAY_MS = 86_400_000

export interface CleanupDeps {
  repos: { decisions: Pick<DecisionsRepo, 'pruneOlderThan'>; equity: Pick<EquityRepo, 'pruneMinuteOlderThan'> }
  now: () => number
  logger: Logger
}

export interface CleanupResult {
  decisions: number
  minuteEquity: number
}

export async function cleanup({ repos, now, logger }: CleanupDeps): Promise<CleanupResult> {
  const t = now()
  const decisions = await repos.decisions.pruneOlderThan(t - DECISIONS_RETENTION_DAYS * DAY_MS)
  const minuteEquity = await repos.equity.pruneMinuteOlderThan(t - MINUTE_EQUITY_RETENTION_DAYS * DAY_MS)
  logger.info({ decisions, minuteEquity }, 'Limpieza diaria')
  return { decisions, minuteEquity }
}
