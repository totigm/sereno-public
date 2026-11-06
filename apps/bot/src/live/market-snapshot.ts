// La fila viva de `market_snapshot` (spec §10 y §11.1): por moneda del universo, la
// marca, el cambio de 24 h, el S′ del último ciclo, la inclinación de la baldosa y su
// estado, del más importante al menos: con posición, degradada, en penitencia, en
// enfriamiento, lista.

import type { EngineSnapshot } from '@sereno/core/src/engine/types'
import type { MarketSymbolView } from '@sereno/db'
import type { MarketData } from './market-data'

export interface SnapshotInput {
  now: number
  symbols: readonly string[]
  market: MarketData
  engine: EngineSnapshot
  sPrime: ReadonlyMap<string, number>
  theta: number
  // Símbolo → desde cuándo no llegan datos.
  degraded: ReadonlyMap<string, number>
}

export function marketSymbols(input: SnapshotInput): MarketSymbolView[] {
  const { now, market, engine, sPrime, theta, degraded } = input
  const open = new Set(engine.real.positions.map((s) => s.position.symbol))
  const views: MarketSymbolView[] = []
  for (const symbol of input.symbols) {
    const markPrice = market.mark(symbol)?.markPrice
    if (markPrice === undefined) continue
    const s = sPrime.get(symbol) ?? null
    const view: MarketSymbolView = {
      symbol,
      markPrice,
      change24h: market.change24h(symbol, now),
      sPrime: s,
      lean: s === null || !(theta > 0) ? 0 : Math.max(-1, Math.min(1, s / theta)),
      state: 'ready',
    }
    const staleSince = degraded.get(symbol)
    const penalty = engine.learning.penalties[symbol]
    const cooldown = engine.real.guard.cooldownUntil[symbol]
    if (open.has(symbol)) view.state = 'in_position'
    else if (staleSince !== undefined) Object.assign(view, { state: 'degraded', staleSince: new Date(staleSince).toISOString() })
    else if (penalty !== undefined && penalty > now) Object.assign(view, { state: 'penalized', stateUntil: new Date(penalty).toISOString() })
    else if (cooldown !== undefined && cooldown > now) Object.assign(view, { state: 'cooldown', stateUntil: new Date(cooldown).toISOString() })
    views.push(view)
  }
  return views
}
