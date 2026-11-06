// Job `accountTiers` (spec §6, "un job opcional"): con la clave de sólo lectura trae el mmr
// del tier 1 de cada moneda y las comisiones de la cuenta y, si difieren de los ajustes de
// la sesión, los guarda como una versión hecha por el bot (`ACCOUNT_TIERS_AUTHOR`); de esa
// versión salen el origen que muestra Ajustes y la entrada del diario. Sin clave no hace
// nada. Una clave rechazada o Binance caído dejan una línea en los errores recientes y no
// se reintenta hasta la próxima corrida (al día siguiente o al reiniciar).

import { ACCOUNT_TIERS_AUTHOR, ACCOUNT_TIERS_PHRASE, sameAccountTiers } from '@sereno/shared'
import { toTierOneMmr } from '../binance/account'
import { isKeyRejected } from '../binance/errors'
import type { BinanceRest } from '../binance/rest'
import { redactSignature } from '../binance/signing'
import type { AccountHookContext } from '../live/live-types'
import type { Logger } from '../logger'
import { errorMessage } from './errors'
import { withAccountTiers, type AccountTiers } from './tiers-risk'

// Las comisiones son de la cuenta: se leen de un contrato cualquiera, el más líquido.
export const COMMISSION_SYMBOL = 'BTCUSDT'
export const NO_KEY_MESSAGE = 'Sin clave de Binance: uso los supuestos de mmr y comisiones'
export const KEY_REJECTED_MESSAGE = 'La clave de Binance no tiene permiso de lectura de futuros: sigo con los supuestos'
const CONFLICT_MESSAGE = 'Los ajustes cambiaron mientras guardaba el mmr y las comisiones de tu cuenta de Binance: vuelvo a probar mañana'
const FETCH_FAILED_MESSAGE = 'No pude traer el mmr y las comisiones de tu cuenta de Binance'
// El universo sólo usa perpetuos: un trimestral no tiene por qué ocupar la tabla de mmr.
const PERPETUAL = 'PERPETUAL'
// Optimistic locking: si Toti guardó en el medio, se relee y se reintenta una vez.
const SAVE_ATTEMPTS = 2

export type AccountRest = Pick<BinanceRest, 'hasKey' | 'leverageBrackets' | 'commissionRate'>

export interface AccountTiersDeps {
  rest: AccountRest
  logger: Logger
}

export type AccountTiersOutcome = 'no_key' | 'updated' | 'unchanged' | 'rejected' | 'failed'

export async function accountTiersJob({ rest, logger }: AccountTiersDeps, ctx: AccountHookContext): Promise<AccountTiersOutcome> {
  if (!rest.hasKey()) return 'no_key'
  let tiers: AccountTiers
  try {
    tiers = await fetchAccountTiers(rest)
  } catch (error) {
    if (isKeyRejected(error)) return fail(logger, ctx, KEY_REJECTED_MESSAGE, 'rejected')
    return fail(logger, ctx, `${FETCH_FAILED_MESSAGE}: ${redactSignature(errorMessage(error))}`, 'failed')
  }

  const catalog = new Set((await ctx.repos.symbols.all()).filter((s) => s.contractType === PERPETUAL).map((s) => s.symbol))
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const row = await ctx.repos.settings.get(ctx.sessionId)
    if (!row) throw new Error(`La sesión ${ctx.sessionId} no tiene ajustes`)
    const risk = withAccountTiers(row.config.risk, tiers, catalog)
    if (sameAccountTiers(row.config.risk, risk)) return 'unchanged'
    const saved = await ctx.repos.settings.update(ctx.sessionId, { risk }, row.version, { by: ACCOUNT_TIERS_AUTHOR })
    if (saved.ok) {
      logger.info({ sessionId: ctx.sessionId, version: saved.version, takerFeeRate: tiers.takerFeeRate, makerFeeRate: tiers.makerFeeRate }, ACCOUNT_TIERS_PHRASE)
      return 'updated'
    }
  }
  return fail(logger, ctx, CONFLICT_MESSAGE, 'failed')
}

async function fetchAccountTiers(rest: AccountRest): Promise<AccountTiers> {
  const [brackets, commission] = await Promise.all([rest.leverageBrackets(), rest.commissionRate(COMMISSION_SYMBOL)])
  return { mmr: toTierOneMmr(brackets), takerFeeRate: commission.takerFeeRate, makerFeeRate: commission.makerFeeRate }
}

function fail<T extends AccountTiersOutcome>(logger: Logger, ctx: AccountHookContext, message: string, outcome: T): T {
  logger.warn({ sessionId: ctx.sessionId }, message)
  ctx.reportError(message)
  return outcome
}
