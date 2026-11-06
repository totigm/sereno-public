// Funding y datos de futuros de una moneda para el replay (spec §9).
//
// - El historial de `fundingRate` se cobra a las abiertas y da la tasa de la señal de
//   funding: en cada liquidación, la tasa que se liquidó (en vivo la señal ve la estimada
//   del período en curso; la histórica es la mejor aproximación que guarda Binance).
// - Interés abierto y ratios sólo existen donde Binance los tiene (los últimos 30 días): se
//   bajan, se guardan en `futures_data` y se suman a lo que ya había (lo que sondeó el vivo
//   o bajaron otros replays). Fuera de eso la señal queda sin dato, como en vivo.

import type { FundingEvent, FuturesSnapshot } from '@sereno/core'
import type { FuturesPoint, FuturesRepo } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import { FUTURES_DATA_HISTORY_MS, type DataRange } from '../binance/types'
import type { CallBudget } from '../jobs/budget'
import { FUTURES_PERIOD } from '../jobs/futures-data'
import { HOUR_MS } from '../live/scheduler'
import { FUTURES_LOOKBACK_MS, toFuturesSnapshots } from '../market/futures-snapshots'

const FUNDING_PAGE = 1000
const FUTURES_DATA_PAGE = 500
// Una hora de margen para no pedir el borde de lo que Binance todavía guarda.
const FUTURES_DATA_REACH_MS = FUTURES_DATA_HISTORY_MS - HOUR_MS

export interface FuturesSource {
  rest: Pick<BinanceRest, 'fundingRate' | 'openInterestHist' | 'globalLongShortAccountRatio' | 'takerLongShortRatio'>
  repos: { futures: Pick<FuturesRepo, 'insert' | 'range'> }
  budget: CallBudget
}

export interface FuturesInput {
  from: number
  to: number
  now: number
  fundingIntervalHours: number
}

export interface ReplayFutures {
  funding: FundingEvent[]
  futures: FuturesSnapshot[]
  // El primer instante del período con interés abierto o ratios, o null si no hubo ninguno.
  dataFrom: number | null
}

export async function replayFutures(source: FuturesSource, symbol: string, input: FuturesInput): Promise<ReplayFutures> {
  const since = input.from - FUTURES_LOOKBACK_MS
  const funding = await fundingHistory(source, symbol, since, input.to)
  const dataSince = Math.max(since, input.now - FUTURES_DATA_REACH_MS)
  if (dataSince < input.to) await source.repos.futures.insert(await futuresData(source, symbol, { startTime: dataSince, endTime: input.to - 1 }))
  // La tasa de funding del vivo (la estimada, del stream) no se mezcla con la liquidada.
  const stored = (await source.repos.futures.range(symbol, since, input.to)).map((p): FuturesPoint => ({ ...p, fundingRate: null, nextFundingTime: null }))
  const interval = input.fundingIntervalHours * HOUR_MS
  const settled = funding.map((e): FuturesPoint => ({ ...emptyPoint(symbol, e.at), fundingRate: e.rate, nextFundingTime: e.at + interval }))
  return {
    funding,
    futures: toFuturesSnapshots([...stored, ...settled]).filter((s) => s.at < input.to),
    dataFrom: dataFromIn(stored, input),
  }
}

// Desde cuándo hay interés abierto o ratios dentro del período. Un dato del margen previo
// (las 8 h antes de `from`) cubre el arranque: el período tiene datos desde `from`. Si
// ninguno cae en el período, no hubo.
function dataFromIn(points: readonly FuturesPoint[], { from, to }: Pick<FuturesInput, 'from' | 'to'>): number | null {
  const withData = points.filter((p) => p.openInterest !== null || p.longShortRatio !== null || p.takerRatio !== null)
  const first = withData[0]
  if (first === undefined || !withData.some((p) => p.at >= from && p.at < to)) return null
  return Math.max(first.at, from)
}

// Liquidaciones con `at` en [from, to), en páginas de hasta 1.000.
async function fundingHistory({ rest, budget }: FuturesSource, symbol: string, from: number, to: number): Promise<FundingEvent[]> {
  const out: FundingEvent[] = []
  for (let startTime = from; startTime < to; ) {
    await budget.acquire('funding', 1)
    const page = (await rest.fundingRate(symbol, { startTime, endTime: to - 1, limit: FUNDING_PAGE })).filter((e) => e.at >= startTime && e.at < to)
    out.push(...page)
    const last = page.at(-1)
    if (last === undefined || page.length < FUNDING_PAGE) break
    startTime = last.at + 1
  }
  return out
}

interface Timed {
  at: number
  value: number
}

const FIELDS = ['openInterest', 'longShortRatio', 'takerRatio'] as const

// Las tres series de período 1h en el rango, combinadas por instante.
async function futuresData(source: FuturesSource, symbol: string, range: Required<DataRange>): Promise<FuturesPoint[]> {
  const { rest } = source
  const series = [
    await paged(source, range, (r) => rest.openInterestHist(symbol, FUTURES_PERIOD, FUTURES_DATA_PAGE, r).then((s) => s.map((p) => ({ at: p.timestamp, value: p.sumOpenInterest })))),
    await paged(source, range, (r) => rest.globalLongShortAccountRatio(symbol, FUTURES_PERIOD, FUTURES_DATA_PAGE, r).then((s) => s.map((p) => ({ at: p.timestamp, value: p.longShortRatio })))),
    await paged(source, range, (r) => rest.takerLongShortRatio(symbol, FUTURES_PERIOD, FUTURES_DATA_PAGE, r).then((s) => s.map((p) => ({ at: p.timestamp, value: p.buySellRatio })))),
  ]
  const byAt = new Map<number, FuturesPoint>()
  for (const [i, points] of series.entries()) {
    const field = FIELDS[i]!
    for (const { at, value } of points) {
      const row = byAt.get(at) ?? emptyPoint(symbol, at)
      row[field] = value
      byAt.set(at, row)
    }
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at)
}

async function paged({ budget }: FuturesSource, { startTime, endTime }: Required<DataRange>, fetchPage: (range: DataRange) => Promise<Timed[]>): Promise<Timed[]> {
  const out: Timed[] = []
  for (let cursor = startTime; cursor <= endTime; ) {
    await budget.acquire('data', 1)
    const page = (await fetchPage({ startTime: cursor, endTime })).filter((p) => p.at >= cursor && p.at <= endTime)
    out.push(...page)
    const last = page.at(-1)
    if (last === undefined || page.length < FUTURES_DATA_PAGE) break
    cursor = last.at + 1
  }
  return out
}

function emptyPoint(symbol: string, at: number): FuturesPoint {
  return { symbol, at, fundingRate: null, nextFundingTime: null, openInterest: null, longShortRatio: null, takerRatio: null }
}
