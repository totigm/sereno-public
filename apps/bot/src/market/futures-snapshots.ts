// De las filas de `futures_data` (cada fuente escribe lo suyo en su instante) a la serie
// de `FuturesSnapshot` que recibe `buildMarketView`: un snapshot por instante con lo
// último conocido hasta ahí, causal (sólo valores ya disponibles en el instante del
// snapshot, ver `FUTURES_AVAILABLE_AFTER_MS`), y el OI
// de hace 1 h y 4 h derivado de la misma serie. La misma función sirve en vivo y para
// armar el replay.
//
// `buildMarketView` toma el último snapshot ≤ t sin mirar su edad. Para que un OI o un
// ratio viejo no siga vigente si se cortan el sondeo y el stream, la serie lleva además
// un snapshot en el instante en que vence cada valor que no se renovó a tiempo.

import type { FuturesSnapshot } from '@sereno/core'
import { lastIndexAtOrBefore } from '@sereno/core/src/market/search'
import type { FuturesPoint, FuturesRepo } from '@sereno/db'
import { FUTURES_POLL_INTERVAL_MS } from '../jobs/futures-data'

const HOUR_MS = 3_600_000

// OI y ratios llegan cada hora (período 1h, sondeo cada 5 minutos). Más viejos que dos
// períodos ya no describen el mercado: el snapshot los da por faltantes (señal sin dato)
// en vez de arrastrarlos. El funding no vence así: la tasa vigente es la última conocida.
export const FUTURES_MAX_AGE_MS = 2 * HOUR_MS

const EXPIRING = ['openInterest', 'longShortRatio', 'takerRatio'] as const
type Field = 'fundingRate' | 'nextFundingTime' | (typeof EXPIRING)[number]
const FIELDS: readonly Field[] = ['fundingRate', 'nextFundingTime', ...EXPIRING]

// Causalidad (§5.2): cada campo cuenta desde que existe, no desde el `at` que le pone
// Binance. El ratio taker de `at` es el del período [at, at + 1 h): se publica al cerrarse
// y el vivo lo ve en el sondeo siguiente, así que cuenta desde at + 1 h + 5 min.
// El OI y el ratio long/short de `at` se publican en `at`, pero el vivo los ve recién en
// el sondeo siguiente (cada 5 min). El funding llega con su instante (stream o liquidación).
// La misma regla sirve al vivo y al replay, así los dos deciden con lo mismo.
export const FUTURES_AVAILABLE_AFTER_MS: Readonly<Record<Field, number>> = {
  fundingRate: 0,
  nextFundingTime: 0,
  openInterest: FUTURES_POLL_INTERVAL_MS,
  longShortRatio: FUTURES_POLL_INTERVAL_MS,
  takerRatio: HOUR_MS + FUTURES_POLL_INTERVAL_MS,
}

// El OI "de hace h" es el punto en (objetivo − 1 período, objetivo]: si falta, no se usa
// uno más viejo, que mediría otro horizonte.
const OI_TOLERANCE_MS = HOUR_MS

// Historia que necesita el primer snapshot de un rango: dos horas de vigencia más 4 h y
// un período de OI hacia atrás (7 h, más los 5 min hasta que el OI se ve), y el último
// funding del intervalo más largo (8 h).
export const FUTURES_LOOKBACK_MS = 8 * HOUR_MS

interface Timed {
  at: number
  value: number
}

// Un valor conocido: `at` es el instante de Binance; `available`, desde cuándo se puede usar.
interface Known extends Timed {
  available: number
}

interface Arrival extends Known {
  field: Field
}

const byAt = (p: Timed): number => p.at

export function toFuturesSnapshots(points: readonly FuturesPoint[]): FuturesSnapshot[] {
  const symbol = points[0]?.symbol
  if (points.some((p) => p.symbol !== symbol)) throw new RangeError('toFuturesSnapshots: puntos de más de un símbolo')
  const sorted = [...points].sort((a, b) => a.at - b.at)
  const oiSeries = sorted.flatMap((p) => (p.openInterest === null ? [] : [{ at: p.at, value: p.openInterest }]))
  // Cada campo de cada fila llega en su instante de disponibilidad; orden estable por llegada.
  const arrivals = sorted
    .flatMap((p) => FIELDS.flatMap((field): Arrival[] => {
      const value = p[field]
      return value === null ? [] : [{ field, at: p.at, available: p.at + FUTURES_AVAILABLE_AFTER_MS[field], value }]
    }))
    .sort((a, b) => a.available - b.available)

  // Varias llegadas en el mismo instante dan un solo snapshot, con todas aplicadas.
  const times = [...new Set([...arrivals.map((a) => a.available), ...expiries(arrivals)])].sort((a, b) => a - b)
  const out: FuturesSnapshot[] = []
  const known: Partial<Record<Field, Known>> = {}
  let next = 0
  for (const at of times) {
    for (let a = arrivals[next]; a !== undefined && a.available <= at; a = arrivals[++next]) known[a.field] = a
    const current = fresh(known.openInterest, at)
    out.push({
      at,
      fundingRate: known.fundingRate?.value ?? null,
      nextFundingTime: known.nextFundingTime?.value ?? null,
      openInterest: current?.value ?? null,
      openInterest1hAgo: current ? valueNear(oiSeries, current.at - HOUR_MS) : null,
      openInterest4hAgo: current ? valueNear(oiSeries, current.at - 4 * HOUR_MS) : null,
      longShortRatio: fresh(known.longShortRatio, at)?.value ?? null,
      takerRatio: fresh(known.takerRatio, at)?.value ?? null,
    })
  }
  return out
}

// Primer instante en que vence cada valor de OI o ratio que no tiene reemplazo antes.
// La vigencia se cuenta desde que el valor está disponible. Puede caer después de la
// última fila: desde ahí ese dato falta.
function expiries(arrivals: readonly Arrival[]): number[] {
  const out: number[] = []
  for (const field of EXPIRING) {
    const ats = arrivals.flatMap((a) => (a.field === field ? [a.available] : []))
    for (const [k, available] of ats.entries()) {
      const expiry = available + FUTURES_MAX_AGE_MS + 1
      const renewed = ats[k + 1]
      if (renewed === undefined || renewed > expiry) out.push(expiry)
    }
  }
  return out
}

// Snapshots de `symbol` con `at` en [from − historia, to), listos para `buildMarketView`.
export async function loadFuturesSnapshots(repo: Pick<FuturesRepo, 'range'>, symbol: string, from: number, to: number): Promise<FuturesSnapshot[]> {
  return toFuturesSnapshots(await repo.range(symbol, from - FUTURES_LOOKBACK_MS, to)).filter((s) => s.at < to)
}

function fresh(value: Known | undefined, at: number): Known | null {
  return value !== undefined && at - value.available <= FUTURES_MAX_AGE_MS ? value : null
}

function valueNear(series: readonly Timed[], target: number): number | null {
  const point = series[lastIndexAtOrBefore(series, byAt, target)]
  return point !== undefined && point.at > target - OI_TOLERANCE_MS ? point.value : null
}
