import type { ViewTimeframe } from '../../src/market/market-view'
import type { ReplayData, ReplayInput } from '../../src/replay/types'
import type { Candle, EngineEvent } from '../../src/types'
import { compositeOf, infoOf, settingsWith, scenarioLearningState } from '../engine/fixtures'
import type { Scorer } from '../../src/engine/types'

// Mercado chico y plano para los tests de causalidad del replay: SOL en 100 con un rango
// fijo por marco (en 1h el ATR(14) da 2: con k 1,5 el stop queda al 3%), sin costos.

export const MIN = 60_000
export const MIN15 = 15 * MIN
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
// Sábado 31/10/2026 a las 08:00 UTC.
export const START = Date.UTC(2026, 9, 31, 8)
export const SYMBOL = 'SOLUSDT'

const SPAN: Record<ViewTimeframe, number> = { '15m': MIN15, '1h': HOUR, '4h': 4 * HOUR }
const HALF_RANGE: Record<ViewTimeframe, number> = { '15m': 0.2, '1h': 1, '4h': 2 }
// Velas de calentamiento antes de START por marco.
const WARMUP: Record<ViewTimeframe, number> = { '15m': 8, '1h': 20, '4h': 4 }

export function flat(tf: ViewTimeframe, openTime: number, price = 100): Candle {
  const half = HALF_RANGE[tf]
  return { openTime, closeTime: openTime + SPAN[tf] - 1, open: price, high: price + half, low: price - half, close: price, volume: 10, quoteVolume: 10 * price, closed: true }
}

// Velas planas desde el calentamiento hasta `end` (exclusive), con las que indique `edit`
// reemplazadas (o quitadas si devuelve null).
export function series(tf: ViewTimeframe, end: number, edit: (c: Candle) => Candle | null = (c) => c): Candle[] {
  const out: Candle[] = []
  for (let t = START - WARMUP[tf] * SPAN[tf]; t < end; t += SPAN[tf]) {
    const c = edit(flat(tf, t))
    if (c) out.push(c)
  }
  return out
}

export interface SyntheticOptions {
  to: number
  // Último instante con datos de SOL (por defecto `to`).
  dataEnd?: number
  edit15m?: (c: Candle) => Candle | null
  // Sólo la vela de marca de 15m (por defecto, igual a la de último precio).
  editMark15m?: (c: Candle) => Candle | null
  edit4h?: (c: Candle) => Candle | null
}

export function syntheticData(options: SyntheticOptions): ReplayData {
  const end = options.dataEnd ?? options.to
  const m15 = series('15m', end, options.edit15m)
  const { editMark15m } = options
  const mark15m = editMark15m ? m15.flatMap((c) => editMark15m(c) ?? []) : m15
  const days: Record<string, string[]> = {}
  for (let t = START - (START % DAY); t < options.to; t += DAY) days[new Date(t).toISOString().slice(0, 10)] = [SYMBOL]
  return {
    symbolsByDay: days,
    candles: { [SYMBOL]: { '15m': { last: m15, mark: mark15m }, '1h': { last: series('1h', end), mark: [] }, '4h': { last: series('4h', end, options.edit4h), mark: [] } } },
    funding: {},
    futures: {},
    infos: { [SYMBOL]: infoOf(SYMBOL) },
    btc: { '15m': [], '4h': [] },
  }
}

export function syntheticInput(data: ReplayData, overrides: Partial<ReplayInput> & { to: number; sink: (e: EngineEvent) => void }): ReplayInput {
  return {
    ...data,
    id: 'causal',
    settings: settingsWith(),
    learningInit: scenarioLearningState(START),
    capital: 1_000,
    from: START,
    paramTuning: false,
    ...overrides,
  }
}

// S′ = 0,8 (long) en los instantes pedidos y 0 en el resto.
export function enterAt(...times: number[]): Scorer {
  const at = new Set(times)
  return (view, weights) => ({ ...compositeOf(at.has(view.t) ? 0.8 : 0), weights: { ...weights } })
}
