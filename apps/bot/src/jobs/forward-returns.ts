// Retornos a 4 h y 24 h de las decisiones (spec §8.1 y §11.1), cada hora a los :02: con
// ellos se mide la fiabilidad de cada señal y el diario cuenta qué pasó después de un
// "esperé". Salen de las velas de 15m de último precio guardadas.
//
// La decisión de `t` se tomó con la vela que cerró en `t`: el retorno a 4 h compara su
// cierre con el de la vela 16 posiciones después (la que cierra en `t + 4 h`); a 24 h, 96.

import type { Candle } from '@sereno/core'
import { FORWARD_RETURN_CANDLES } from '@sereno/core/src/replay/weekly-reliability'
import type { CandlesRepo, DecisionRecord, DecisionsRepo, ForwardReturns, ForwardReturnUpdate, PendingCursor } from '@sereno/db'
import { INTERVAL_MS } from '../binance/types'

const M15 = INTERVAL_MS['15m']
// El de 4 h es el mismo que usa la fiabilidad semanal dentro del replay.
const FORWARD_24H_CANDLES = 96
const PAGE = 5000
// Tope de páginas por corrida: lo que quede se completa en la siguiente.
const MAX_PAGES = 20

// `closeAt(openTime)`: el cierre de la vela de 15m que abre ahí, si se conoce.
export function forwardReturnsAt(closeAt: (openTime: number) => number | undefined, t: number): ForwardReturns {
  const base = closeAt(t - M15)
  const after = (candles: number): number | null => {
    const later = closeAt(t - M15 + candles * M15)
    return base === undefined || later === undefined || base <= 0 ? null : later / base - 1
  }
  return { forwardReturn4h: after(FORWARD_RETURN_CANDLES), forwardReturn24h: after(FORWARD_24H_CANDLES) }
}

// Cierres de velas cerradas por apertura.
export function closesByOpen(candles: readonly Candle[]): (openTime: number) => number | undefined {
  const closes = new Map(candles.filter((c) => c.closed).map((c) => [c.openTime, c.close]))
  return (openTime) => closes.get(openTime)
}

export interface ForwardReturnsDeps {
  repos: { decisions: Pick<DecisionsRepo, 'listPendingForwardReturns' | 'fillForwardReturns'>; candles: Pick<CandlesRepo, 'range'> }
  sessionId: string
  now: number
  pageSize?: number
}

// Devuelve cuántas decisiones completó. Recorre las pendientes de la más vieja a la más
// nueva con un cursor: las que no se pueden completar (velas que nunca se guardaron, de
// una moneda que salió del universo) no tapan a las que siguen.
export async function forwardReturnsJob({ repos, sessionId, now, pageSize = PAGE }: ForwardReturnsDeps): Promise<number> {
  let filled = 0
  let after: PendingCursor | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const pending = await repos.decisions.listPendingForwardReturns(sessionId, now, { limit: pageSize, ...(after ? { after } : {}) })
    const updates = await updatesFor(repos.candles, pending, now)
    if (updates.length > 0) filled += await repos.decisions.fillForwardReturns(updates)
    const last = pending.at(-1)
    if (last === undefined || pending.length < pageSize) break
    after = { candleCloseTime: last.candleCloseTime, id: last.id }
  }
  return filled
}

async function updatesFor(candles: Pick<CandlesRepo, 'range'>, pending: readonly DecisionRecord[], now: number): Promise<ForwardReturnUpdate[]> {
  const bySymbol = new Map<string, DecisionRecord[]>()
  for (const d of pending) {
    const list = bySymbol.get(d.symbol)
    if (list) list.push(d)
    else bySymbol.set(d.symbol, [d])
  }
  const updates: ForwardReturnUpdate[] = []
  for (const [symbol, decisions] of bySymbol) {
    const first = Math.min(...decisions.map((d) => d.candleCloseTime))
    const last = Math.max(...decisions.map((d) => d.candleCloseTime))
    const closeAt = closesByOpen(await candles.range(symbol, '15m', 'last', first - M15, last + FORWARD_24H_CANDLES * M15))
    for (const d of decisions) {
      const r = forwardReturnsAt((openTime) => (openTime + M15 <= now ? closeAt(openTime) : undefined), d.candleCloseTime)
      const update: ForwardReturnUpdate = { id: d.id }
      if (d.forwardReturn4h === null && r.forwardReturn4h !== null) update.forwardReturn4h = r.forwardReturn4h
      if (d.forwardReturn24h === null && r.forwardReturn24h !== null) update.forwardReturn24h = r.forwardReturn24h
      if (update.forwardReturn4h !== undefined || update.forwardReturn24h !== undefined) updates.push(update)
    }
  }
  return updates
}
