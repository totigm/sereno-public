import type { ReplayParams } from '@sereno/db'
import type { LearningOrigin, ReplayStatus } from '@sereno/shared'
import { simulateBook } from './book'
import { coinOf, type Coin } from './coins'
import type { DemoSession } from './dataset'
import { buildDecisions, forwardReturns } from './decisions'
import { equitySeries } from './equity'
import { tradeComposites } from './live'
import type { Market } from './market'
import { rngFor } from './random'
import { replayTrades } from './replay-trades'
import { DEMO_SETTINGS, settingsAt, settingsTimeline } from './settings'
import { marketSymbols, universeDays } from './snapshot'
import type { TradeSpec } from './spec'
import { replayVerdict } from './summary'
import { alignDown, CYCLE_MS, DAY_MS, FOUR_HOURS_MS, MINUTE_MS } from './time'

// Los replays de la pantalla de replays. El terminado corre sobre el mismo mercado que
// la simulación en vivo (la tabla de velas es una sola) y guarda lo mismo que guardaría
// el bot: trades, curva, aprendizaje, todas sus decisiones con sus retornos, el
// universo de cada día, la última foto del mercado y el veredicto como mensaje. Los
// que corren o esperan sólo tienen la fila.

// Las monedas que el replay operó: de las más líquidas, para no guardar 30 caminos de
// 90 días. Sin SOL: su contrato mínimo (1 SOL) vale más de US$ 170 y, con el precio de
// hace tres meses y la confianza de la moneda baja después de dos stops, el tamaño
// redondea a cero y el bot no abriría el trade que el replay ya decidió.
const REPLAY_SYMBOLS = ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'LTCUSDT', 'DOTUSDT']
// Lo que tardó en correr: descargar y simular 90 días.
const RUN_MS = 6 * MINUTE_MS + 40_000
// Velas guardadas antes del primer día simulado: el calentamiento de los indicadores.
const WARMUP_MS = DAY_MS

export interface FinishedReplaySpec {
  id: string
  name: string
  // Cuándo se pidió; simula los `params.days` días anteriores.
  runAt: number
  params: ReplayParams
}

// Lo que el replay necesita del mercado antes de que exista: su ventana, sus monedas y
// sus trades, que el mercado tiene que cumplir.
export interface FinishedReplayPlan {
  spec: FinishedReplaySpec
  start: number
  end: number
  coins: readonly Coin[]
  trades: TradeSpec[]
  // Desde dónde guarda velas: alineado a 4 h para que el marco mayor arranque completo.
  candleStart: number
}

const originOf = (params: ReplayParams): LearningOrigin => (params.learningOrigin === 'zero' ? 'zero' : 'continued')

function emptySession(row: DemoSession['row']): DemoSession {
  return { row, settings: [], universe: [], books: null, decisions: [], forwardReturns: new Map(), equity: [], marketSnapshot: null, bot: null, learning: null }
}

export function planFinishedReplay(spec: FinishedReplaySpec, seed: number): FinishedReplayPlan {
  const end = alignDown(spec.runAt, CYCLE_MS)
  const start = end - spec.params.days * DAY_MS
  const coins = REPLAY_SYMBOLS.map(coinOf)
  const trades = replayTrades({ rng: rngFor(seed, 'replay', spec.id), idPrefix: `${spec.id}_`, coins, start, end, openAtEnd: 2 })
  return { spec, start, end, coins, trades, candleStart: alignDown(start - WARMUP_MS, FOUR_HOURS_MS) }
}

export function buildFinishedReplay(plan: FinishedReplayPlan, { seed, market }: { seed: number; market: Market }): DemoSession {
  const { spec, start, end, coins } = plan
  const { params } = spec
  const timeline = settingsTimeline([{ at: start, by: null, patch: {} }])
  const at = settingsAt(timeline)
  const composites = tradeComposites(seed, plan.trades, market, coins)
  const input = { seed, capitalInicial: params.capital, settingsAt: at, market, composites, start, end }
  const real = simulateBook({ ...input, kind: 'real', idPrefix: 'pos_' })
  const shadow = simulateBook({ ...input, kind: 'shadow', idPrefix: 'pos_' })
  const equity = equitySeries({ capitalInicial: params.capital, settingsAt: at, market, real, shadow, start, end, minuteTailMs: 0 })
  const result = replayVerdict({ seed, days: params.days, real, shadow, equity, capitalInicial: params.capital })
  // Un ciclo por cierre de vela de la ventana: el primero, una vela después del arranque.
  const cycles: number[] = []
  for (let t = start + CYCLE_MS; t <= end; t += CYCLE_MS) cycles.push(t)
  const decisions = buildDecisions({ seed, sessionId: spec.id, capitalInicial: params.capital, coins, market, cycles, settingsAt: at, real, composites, degraded: null, forced: new Map() })
  const session = emptySession({
    id: spec.id,
    kind: 'replay',
    name: spec.name,
    status: 'listo',
    capitalInicial: params.capital,
    baseBlindaje: real.shield?.baseBlindaje ?? params.capital,
    protegido: real.shield?.protegido ?? 0,
    settingsSnapshot: DEMO_SETTINGS,
    learningOrigin: originOf(params),
    startedAt: new Date(spec.runAt),
    endedAt: new Date(spec.runAt + RUN_MS),
    progreso: 1,
    mensaje: result.reason,
    replayParams: params,
  })
  return {
    ...session,
    settings: timeline,
    universe: universeDays(seed, coins, start, end),
    books: { real, shadow },
    decisions,
    forwardReturns: forwardReturns(decisions, market, end),
    equity,
    // La foto del mercado del reloj simulado al terminar; una escritura por ciclo.
    marketSnapshot: { updatedAt: end, version: cycles.length, symbols: marketSymbols({ coins, market, at: end, decisions, real, settings: DEMO_SETTINGS, degraded: null }) },
    learning: real.learning,
  }
}

export interface PendingReplaySpec {
  id: string
  name: string
  requestedAt: number
  params: ReplayParams
  status: Extract<ReplayStatus, 'en_cola' | 'descargando' | 'simulando'>
  progreso: number
  mensaje: string | null
}

export function buildPendingReplay(spec: PendingReplaySpec): DemoSession {
  return emptySession({
    id: spec.id,
    kind: 'replay',
    name: spec.name,
    status: spec.status,
    capitalInicial: spec.params.capital,
    baseBlindaje: spec.params.capital,
    protegido: 0,
    settingsSnapshot: DEMO_SETTINGS,
    learningOrigin: originOf(spec.params),
    startedAt: new Date(spec.requestedAt),
    progreso: spec.progreso,
    mensaje: spec.mensaje,
    replayParams: spec.params,
  })
}
