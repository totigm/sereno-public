import { and, desc, eq } from 'drizzle-orm'
import { settingsHistory, type Db } from '@sereno/db'
import { ACCOUNT_TIERS_AUTHOR } from '@sereno/shared'
import type { AccountTiersView } from '../../fees-origin'

/** La última versión de los ajustes que guardó el bot con el mmr y las comisiones de la cuenta; null si no hay. */
export async function lastAccountTiers(db: Db, sessionId: string): Promise<AccountTiersView | null> {
  const [row] = await db
    .select({ config: settingsHistory.config, changedAt: settingsHistory.changedAt })
    .from(settingsHistory)
    .where(and(eq(settingsHistory.sessionId, sessionId), eq(settingsHistory.changedBy, ACCOUNT_TIERS_AUTHOR)))
    .orderBy(desc(settingsHistory.version))
    .limit(1)
  if (!row) return null
  const { mmrBySymbol, takerFeeRate, makerFeeRate } = row.config.risk
  return { at: row.changedAt.getTime(), mmrBySymbol, takerFeeRate, makerFeeRate }
}
