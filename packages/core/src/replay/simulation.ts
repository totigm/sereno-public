import type { CycleContext } from '../engine/types'
import type { FundingEvent, MarketView } from '../types'
import { playCandle, type CandleFeed } from './candle-player'
import { CANDLE_MS } from './clock'
import type { CandlePhase } from './intra-candle'
import type { Lane } from './lane'
import type { ReplayMarket } from './market'

// El bucle del replay (spec §9): el reloj avanza vela a vela y en cada vela de 15m cada
// corrida (1) cobra el funding de esa vela, (2) decide al cierre de la vela anterior con
// vistas causales, llenando a la apertura de esta, y (3) recorre la vela por el camino
// canónico. Varias corridas avanzan juntas sobre las mismas vistas (ajuste de parámetros).

export interface SimulationHooks {
  beforeSlot?: (slot: number) => Promise<void>
  afterPhase?: (slot: number, phase: CandlePhase) => void
  // La vela de una moneda se recorre con la sombra del lado contrario a lo real.
  opposed?: (slot: number, symbol: string) => void
  // Si devuelve una promesa, la vela siguiente espera a que se resuelva.
  afterSlot?: (slot: number) => void | Promise<void>
}

export interface SimulationWindow {
  from: number
  to: number
}

export async function simulate(market: ReplayMarket, lanes: readonly Lane[], window: SimulationWindow, hooks: SimulationHooks = {}): Promise<void> {
  for (let slot = window.from; slot < window.to; slot += CANDLE_MS) {
    await hooks.beforeSlot?.(slot)
    const funding = market.fundingIn(slot, slot + CANDLE_MS)
    for (const lane of lanes) await runSlot(market, lane, slot, funding, hooks)
    await hooks.afterSlot?.(slot)
  }
}

async function runSlot(market: ReplayMarket, lane: Lane, slot: number, funding: readonly FundingEvent[], hooks: SimulationHooks): Promise<void> {
  lane.clock.advance(slot)
  // Binance cobra el funding en el borde de una vela (a veces unos ms después): va antes de
  // la decisión, como en vivo, donde la decisión llega unos segundos después del cierre.
  for (const event of funding) await lane.engine.onFunding(event)
  const { views, context } = cycleOf(market, lane, slot)
  await lane.engine.onCandleClose(views, context)
  await playCandle(lane, slot, feedsOf(market, lane, slot), {
    fromOpen: false,
    onPhase: (phase) => hooks.afterPhase?.(slot, phase),
    onOpposed: (symbol) => hooks.opposed?.(slot, symbol),
  })
}

// Las monedas del ciclo: el universo del día y, al final, las que siguen sólo por tener
// abiertas. Las abiertas sin más velas se cierran como deslistadas y no tienen vista.
function cycleOf(market: ReplayMarket, lane: Lane, slot: number): { views: MarketView[]; context: CycleContext } {
  const open = lane.levels.symbols()
  const delisted = open.filter((symbol) => !market.hasDataFrom(symbol, slot))
  const universe = market.universe(slot).filter((symbol) => !delisted.includes(symbol))
  const kept = open.filter((symbol) => !universe.includes(symbol) && !delisted.includes(symbol)).sort()
  const symbols = [...universe, ...kept]
  return {
    views: symbols.map((symbol) => market.view(symbol, slot)),
    context: { missingSymbols: symbols.filter((symbol) => !market.hasDecisionCandle(symbol, slot)), degraded: [], delisted },
  }
}

function feedsOf(market: ReplayMarket, lane: Lane, slot: number): Map<string, CandleFeed> {
  const feeds = new Map<string, CandleFeed>()
  for (const symbol of lane.levels.symbols()) {
    const feed = market.feed(symbol, slot)
    if (feed) feeds.set(symbol, feed)
  }
  return feeds
}
