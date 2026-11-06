import { cache } from 'react'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { coinName } from '@sereno/core/src/journal/coin-name'
import { decisions, type Db, type SymbolRecord, type UniverseExcluded, type UniverseExcludedEntry } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { db, repos } from '../db'
import type { AccountTiersView } from '../fees-origin'
import type { LivePayload } from '../live/types'
import { getLive } from './books'
import { anchorOf, getSessionView, type SessionView } from './session'
import { lastAccountTiers } from './sql/account-tiers'
import { shieldedAt } from './sql/equity'
import { learningSources, type LearningSources } from './sql/sessions'

const DAY_MS = 86_400_000
const HISTORY = 20
// Los contratos que Binance lista para operar (los que están en liquidación o pausados no).
const TRADING = 'TRADING'

export interface SettingsHistoryView {
  version: number
  config: Settings
  /** Email de quien guardó; null si fue el bot (pausa automática). */
  changedBy: string | null
  changedAt: number
}

/** Por qué una moneda queda fuera: un filtro del universo del día o el mínimo del contrato. */
export type UniverseOutReason = UniverseExcludedEntry['reason'] | 'below_min_notional'

export interface UniverseOutView {
  reason: UniverseOutReason
  /** El dato que precisa el motivo; en `below_min_notional`, el mínimo nocional del contrato (USD). */
  detail?: string
  /** Estaba fijada y aun así no entró. */
  pinned?: true
}

export interface AjustesData {
  session: SessionView
  live: LivePayload
  /** null sólo si la sesión no tiene ajustes (un replay viejo): todo en sólo lectura. */
  settings: { config: Settings; version: number; updatedAt: number; updatedBy: string | null } | null
  /** Los valores del documento, para "restablecer" y para mostrar los por defecto. */
  defaults: Settings
  /** Las últimas versiones guardadas, la más nueva primero. */
  history: SettingsHistoryView[]
  universe: {
    /** Las monedas del tablero ahora. */
    current: string[]
    /** Contratos operables para fijar o excluir. */
    available: { symbol: string; name: string }[]
    /** Monedas del universo que el bot no pudo abrir en las últimas 24 h por el mínimo del contrato. */
    belowMinimum: string[]
    /**
     * Las que quedan fuera y por qué, por símbolo: las del último universo del día (filtros y
     * fijadas que no entraron) y las de `belowMinimum`, porque el mínimo de Binance es mayor
     * que lo que permite tu capital. Si una moneda está en las dos, manda el filtro.
     */
    excluded: Record<string, UniverseOutView>
  }
  /** Para "Nueva simulación": de dónde puede arrancar el aprendizaje. */
  learningSources: LearningSources
  /** Cuándo se disparó el blindaje vigente ("Blindaste … el 20 de octubre"); null sin blindaje. */
  shieldedAt: number | null
  /** El mmr y las comisiones que el bot trajo de la cuenta de Binance la última vez; null si nunca. */
  accountTiers: AccountTiersView | null
}

export const getAjustesData = cache(async (sessionId: string): Promise<AjustesData | null> => {
  const [session, live] = await Promise.all([getSessionView(sessionId), getLive(sessionId)])
  if (!session || !live) return null
  const anchor = anchorOf(session, live.now)
  const [row, history, symbols, belowMinimum, universeDay, sources, shielded, accountTiers] = await Promise.all([
    repos.settings.get(sessionId),
    repos.settings.history(sessionId, HISTORY),
    repos.symbols.all(),
    belowMinimumSymbols(db, sessionId, anchor - DAY_MS, anchor + 1),
    repos.universeDays.latest(sessionId),
    learningSources(db),
    session.protegido > 0 ? shieldedAt(db, sessionId) : null,
    lastAccountTiers(db, sessionId),
  ])
  return {
    session,
    live,
    settings: row ? { config: row.config, version: row.version, updatedAt: row.updatedAt.getTime(), updatedBy: row.updatedBy } : null,
    defaults: DEFAULT_SETTINGS,
    history: history.map((h) => ({ version: h.version, config: h.config, changedBy: h.changedBy, changedAt: h.changedAt.getTime() })),
    universe: {
      current: (live.market?.symbols ?? []).map((s) => s.symbol),
      available: symbols.filter((s) => s.status === TRADING).map((s) => ({ symbol: s.symbol, name: coinName(s.symbol) })),
      belowMinimum,
      excluded: universeOut(universeDay?.excluded ?? {}, belowMinimum, symbols),
    },
    learningSources: sources,
    shieldedAt: shielded,
    accountTiers,
  }
})

function universeOut(excluded: UniverseExcluded, belowMinimum: string[], symbols: SymbolRecord[]): Record<string, UniverseOutView> {
  const minNotional = new Map(symbols.map((s) => [s.symbol, s.minNotional]))
  const out: Record<string, UniverseOutView> = {}
  for (const symbol of belowMinimum) {
    const min = minNotional.get(symbol)
    out[symbol] = min === undefined ? { reason: 'below_min_notional' } : { reason: 'below_min_notional', detail: String(min) }
  }
  return { ...out, ...excluded }
}

async function belowMinimumSymbols(db: Db, sessionId: string, from: number, to: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: decisions.symbol })
    .from(decisions)
    .where(
      and(
        eq(decisions.sessionId, sessionId),
        eq(decisions.action, 'blocked:below_min_notional'),
        gte(decisions.candleCloseTime, new Date(from)),
        lt(decisions.candleCloseTime, new Date(to)),
      ),
    )
    .orderBy(asc(decisions.symbol))
  return rows.map((r) => r.symbol)
}
