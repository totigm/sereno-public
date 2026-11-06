import type { Side } from '@sereno/core'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { MarketSymbolView } from '@sereno/db'
import type { MarketSnapshotView, OpenPositionView } from '@/lib/live/types'

// Lo que muestra cada baldosa, derivado del snapshot de mercado y de las abiertas que
// llegan en vivo (spec §11.1, Monedas). Puro: corre en cada refresco.

export type TileState =
  | { kind: 'position'; side: Side; leverage: number; /** Resultado neto a la marca; null sin precio. */ net: number | null }
  | { kind: 'degraded'; since: number | null }
  | { kind: 'cooldown'; until: number | null }
  | { kind: 'penalized'; until: number | null }
  | { kind: 'ready' }

export interface TileModel {
  symbol: string
  name: string
  markPrice: number | null
  change24h: number | null
  sPrime: number | null
  state: TileState
}

function instant(iso: string | undefined): number | null {
  if (iso === undefined) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

// La abierta manda sobre el estado del snapshot: el motor no evalúa entradas en una
// moneda con posición, y la lista de abiertas es la fuente del chip y del resultado.
function stateOf(view: MarketSymbolView | undefined, open: OpenPositionView | undefined): TileState {
  if (open) return { kind: 'position', side: open.side, leverage: open.leverage, net: open.valuation.net }
  switch (view?.state) {
    case 'degraded':
      return { kind: 'degraded', since: instant(view.staleSince) }
    case 'cooldown':
      return { kind: 'cooldown', until: instant(view.stateUntil) }
    case 'penalized':
      return { kind: 'penalized', until: instant(view.stateUntil) }
    default:
      return { kind: 'ready' }
  }
}

const strength = (t: TileModel): number => (t.sPrime === null ? -1 : Math.abs(t.sPrime))

/**
 * Las baldosas en el orden del tablero: primero las que tienen posición, después por
 * |S′| (spec §11.1). Los empates conservan el orden del snapshot, que es el del universo.
 */
export function boardTiles(market: MarketSnapshotView | null, open: readonly OpenPositionView[]): TileModel[] {
  const views = new Map((market?.symbols ?? []).map((v) => [v.symbol, v]))
  const positions = new Map(open.map((p) => [p.symbol, p]))
  const symbols = [...new Set([...views.keys(), ...positions.keys()])]
  const tiles = symbols.map((symbol): TileModel => {
    const view = views.get(symbol)
    return {
      symbol,
      name: coinName(symbol),
      markPrice: view?.markPrice ?? null,
      change24h: view?.change24h ?? null,
      sPrime: view?.sPrime ?? null,
      state: stateOf(view, positions.get(symbol)),
    }
  })
  const held = (t: TileModel) => (t.state.kind === 'position' ? 1 : 0)
  return tiles.sort((a, b) => held(b) - held(a) || strength(b) - strength(a))
}
