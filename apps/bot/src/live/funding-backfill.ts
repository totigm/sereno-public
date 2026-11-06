// Funding que venció mientras el bot no estaba (spec §6 y §12): al retomar, el historial
// de REST trae cada liquidación con su tasa y su marca. Se cobran las posteriores a la
// apertura de todas las abiertas de la moneda y a lo ya cobrado (los eventos `funding`
// guardados): nunca dos veces ni a una posición que en ese instante todavía no existía.

import type { FundingEvent, Position } from '@sereno/core'
import type { Repos } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'

// Binance devuelve hasta 1.000 liquidaciones por pedido: casi un año de 8 h.
const HISTORY_LIMIT = 1_000

export interface MissedFundingDeps {
  repos: Pick<Repos, 'positions'>
  rest: Pick<BinanceRest, 'fundingRate'>
}

export async function missedFunding(deps: MissedFundingDeps, open: readonly Position[], now: number): Promise<FundingEvent[]> {
  const since = new Map<string, number>()
  for (const position of open) {
    const charged = (await deps.repos.positions.listEvents(position.id)).filter((e) => e.kind === 'funding').map((e) => e.at.getTime())
    since.set(position.symbol, Math.max(since.get(position.symbol) ?? 0, position.openedAt, ...charged))
  }
  const due: FundingEvent[] = []
  for (const [symbol, from] of since) {
    if (from >= now) continue
    const history = await deps.rest.fundingRate(symbol, { startTime: from + 1, endTime: now, limit: HISTORY_LIMIT })
    due.push(...history.filter((f) => f.at > from && f.at <= now))
  }
  return due.sort((a, b) => a.at - b.at)
}
