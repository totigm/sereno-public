import type { Candle } from '@sereno/core'
import type { CandleKey } from '@sereno/db'
import { DEMO_SETTINGS } from './settings'
import { COINS } from './coins'
import type { DemoSession } from './dataset'
import { buildLive, liveCandleStart, marketCandles, type LiveSpec } from './live'
import { buildMarket } from './market'
import { buildFinishedReplay, planFinishedReplay, type FinishedReplaySpec } from './replay'
import { CYCLE_MS } from './time'

// Todo lo que pasa en un escenario sobre un solo mercado, como en el bot: la tabla de
// velas es compartida, así que la simulación en vivo y los replays terminados operan
// sobre los mismos precios. El mercado arranca con el replay más viejo y termina en el
// último latido; cada moneda guarda velas desde la primera sesión guardada que la usa.
// Los replays forman parte del mercado aunque el escenario no los guarde: así la
// simulación en vivo es la misma con o sin ellos.

export interface WorldInput {
  seed: number
  // Último instante en que el bot escribió.
  botSeenAt: number
  live: LiveSpec
  replays: readonly FinishedReplaySpec[]
  // Si el escenario guarda los replays: sus sesiones y las velas de su ventana.
  saveReplays: boolean
  // Otras sesiones en vivo sobre el mismo mercado (la de plata real), con trades que ya
  // están en `live`: no dan forma al mercado, lo comparten.
  alsoLive?: readonly LiveSpec[]
}

export interface World {
  live: DemoSession
  alsoLive: DemoSession[]
  replays: DemoSession[]
  candles: { key: CandleKey; items: Candle[] }[]
}

export function buildWorld({ seed, botSeenAt, live, replays, saveReplays, alsoLive = [] }: WorldInput): World {
  const shaped = new Set(live.trades.map((t) => t.id))
  const foreign = alsoLive.flatMap((spec) => spec.trades).find((t) => !shaped.has(t.id))
  if (foreign) throw new Error(`El trade ${foreign.id} de otra sesión en vivo no está en la simulación: no tiene mercado`)
  const plans = replays.map((spec) => planFinishedReplay(spec, seed))
  const liveStart = liveCandleStart(live)
  const market = buildMarket({
    seed,
    coins: COINS,
    grid: { start: Math.min(liveStart, ...plans.map((p) => p.candleStart)), step: CYCLE_MS, end: botSeenAt },
    trades: [...live.trades, ...plans.flatMap((p) => p.trades)],
    settings: DEMO_SETTINGS,
  })
  const saved = saveReplays ? plans : []
  const since = new Map(COINS.map((c) => [c.symbol, liveStart]))
  for (const plan of saved) {
    for (const coin of plan.coins) since.set(coin.symbol, Math.min(since.get(coin.symbol) ?? plan.candleStart, plan.candleStart))
  }
  return {
    live: buildLive(live, { seed, botSeenAt, market }),
    alsoLive: alsoLive.map((spec) => buildLive(spec, { seed, botSeenAt, market })),
    replays: saved.map((plan) => buildFinishedReplay(plan, { seed, market })),
    candles: marketCandles(market, since),
  }
}
