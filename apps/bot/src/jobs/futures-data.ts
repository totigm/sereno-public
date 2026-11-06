// Datos de futuros por REST cada 5 minutos (spec §5.2): interés abierto, ratio long/short
// de cuentas y ratio taker buy/sell, todos de período 1h (los mismos que baja el replay,
// así el motor ve igual granularidad en vivo y en replay). Cada punto se guarda en su
// propio instante; el OI de hace 1 h y 4 h se deriva de esa serie (`market/futures-snapshots`).
//
// Límite: `/futures/data/*` tiene 1.000 pedidos por 5 minutos. Son 3 por símbolo y
// sondeo: 30 monedas usan 90 y aun un universo de 100 con abiertas queda debajo de 350.

import type { FuturesPoint, FuturesRepo } from '@sereno/db'
import type { BinanceRest } from '../binance/rest'
import type { DataPeriod } from '../binance/types'
import type { Logger } from '../logger'
import { errorMessage, isSymbolScoped, type SymbolFailure } from './errors'
import { forEachLimit } from './pool'

export const FUTURES_POLL_INTERVAL_MS = 5 * 60_000
export const FUTURES_PERIOD: DataPeriod = '1h'
// El punto vigente y los cuatro anteriores: alcanza para el OI de hace 4 h y rellena
// las horas que se hayan perdido en un corte corto.
export const FUTURES_POINTS = 5
export const FUTURES_REQUESTS_PER_SYMBOL = 3
const DEFAULT_CONCURRENCY = 4

export interface FuturesDataDeps {
  rest: Pick<BinanceRest, 'openInterestHist' | 'globalLongShortAccountRatio' | 'takerLongShortRatio'>
  repos: { futures: Pick<FuturesRepo, 'insert'> }
  logger: Logger
  concurrency?: number
}

export interface FuturesPollResult {
  // Filas escritas (una por símbolo e instante).
  points: number
  failed: SymbolFailure[]
}

export async function pollFuturesData(deps: FuturesDataDeps, symbols: readonly string[]): Promise<FuturesPollResult> {
  const { logger, concurrency = DEFAULT_CONCURRENCY } = deps
  let points = 0
  const failed: SymbolFailure[] = []
  await forEachLimit([...new Set(symbols)], concurrency, async (symbol) => {
    const { rows, error } = await fetchSymbol(deps.rest, symbol)
    // Lo que llegó se guarda aunque falte una serie: esa señal queda sin dato y las otras no.
    if (rows.length > 0) await deps.repos.futures.insert(rows)
    points += rows.length
    if (error !== null) {
      failed.push({ symbol, error })
      logger.warn({ symbol, err: error }, 'Datos de futuros: Binance rechazó el pedido del símbolo')
    }
  })
  return { points, failed }
}

interface Timed {
  at: number
  value: number
}

const FIELDS = ['openInterest', 'longShortRatio', 'takerRatio'] as const satisfies readonly (keyof FuturesPoint)[]

// Las tres series del símbolo, combinadas por instante. Un 400 de una serie se informa
// y las demás se guardan igual; un error de todos (451, 429, red) se propaga.
async function fetchSymbol(rest: FuturesDataDeps['rest'], symbol: string): Promise<{ rows: FuturesPoint[]; error: string | null }> {
  // `allSettled`: si una falla, las otras dos no quedan como rechazos sin atender.
  const settled = await Promise.allSettled([
    rest.openInterestHist(symbol, FUTURES_PERIOD, FUTURES_POINTS).then((s) => s.map((p): Timed => ({ at: p.timestamp, value: p.sumOpenInterest }))),
    rest.globalLongShortAccountRatio(symbol, FUTURES_PERIOD, FUTURES_POINTS).then((s) => s.map((p): Timed => ({ at: p.timestamp, value: p.longShortRatio }))),
    rest.takerLongShortRatio(symbol, FUTURES_PERIOD, FUTURES_POINTS).then((s) => s.map((p): Timed => ({ at: p.timestamp, value: p.buySellRatio }))),
  ])
  const byAt = new Map<number, FuturesPoint>()
  let error: string | null = null
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      if (!isSymbolScoped(outcome.reason)) throw outcome.reason
      error ??= errorMessage(outcome.reason)
      continue
    }
    const field = FIELDS[i]!
    for (const { at, value } of outcome.value) {
      // El funding no viene de acá: null no pisa lo que escribió el stream en el mismo instante.
      const row = byAt.get(at) ?? { symbol, at, fundingRate: null, nextFundingTime: null, openInterest: null, longShortRatio: null, takerRatio: null }
      row[field] = value
      byAt.set(at, row)
    }
  }
  return { rows: [...byAt.values()].sort((a, b) => a.at - b.at), error }
}
