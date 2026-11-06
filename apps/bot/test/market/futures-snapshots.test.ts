import { describe, expect, it } from 'vitest'
import type { FuturesPoint } from '@sereno/db'
import type { FuturesSnapshot } from '@sereno/core'
import { FUTURES_AVAILABLE_AFTER_MS, FUTURES_MAX_AGE_MS, toFuturesSnapshots } from '../../src/market/futures-snapshots'

const H = 3_600_000
const T = Date.UTC(2026, 9, 31, 0, 0, 0)
const MIN = 60_000
// OI y long/short se ven en el sondeo siguiente; el taker, al cerrar su período.
const L = 5 * MIN
const TK = H + L

// Lo que ve una vista en `t`: el último snapshot con at ≤ t (como `buildMarketView`).
function seen(snapshots: readonly FuturesSnapshot[], t: number): FuturesSnapshot | undefined {
  return snapshots.filter((s) => s.at <= t).at(-1)
}

function point(at: number, patch: Partial<FuturesPoint> = {}): FuturesPoint {
  return { symbol: 'SOLUSDT', at, fundingRate: null, nextFundingTime: null, openInterest: null, longShortRatio: null, takerRatio: null, ...patch }
}

// OI por hora de T−4h a T (100, 110, …, 140), con ratios en cada hora.
function hourly(skip: number[] = []): FuturesPoint[] {
  return [4, 3, 2, 1, 0]
    .filter((h) => !skip.includes(h))
    .map((h) => point(T - h * H, { openInterest: 140 - h * 10, longShortRatio: 1 + h / 10, takerRatio: 0.9 + h / 100 }))
}

describe('toFuturesSnapshots', () => {
  it('cada campo cuenta desde que está disponible: OI y long/short a los 5 min, taker a la hora y 5 min, funding al instante', () => {
    expect(FUTURES_AVAILABLE_AFTER_MS).toEqual({ fundingRate: 0, nextFundingTime: 0, openInterest: L, longShortRatio: L, takerRatio: TK })
  })

  it('arma un snapshot por instante de llegada, en orden, con el OI de hace 1 h y 4 h derivado de la serie', () => {
    const funding = point(T - H / 2, { fundingRate: 0.0001, nextFundingTime: T + 4 * H })
    const snapshots = toFuturesSnapshots([...hourly().reverse(), funding])
    // Los dos últimos son los vencimientos del OI/long-short y del taker de T (ver los tests de vigencia).
    expect(snapshots.map((s) => s.at)).toEqual([
      // Con el taker a 1 h + 5 min, cada uno llega junto con el OI de la hora siguiente.
      T - 4 * H + L,
      T - 3 * H + L,
      T - 2 * H + L,
      T - H + L,
      T - H / 2,
      T + L,
      T + TK,
      T + L + FUTURES_MAX_AGE_MS + 1,
      T + TK + FUTURES_MAX_AGE_MS + 1,
    ])
    expect(snapshots.find((s) => s.at === T + L)).toEqual({
      at: T + L,
      fundingRate: 0.0001,
      nextFundingTime: T + 4 * H,
      openInterest: 140,
      openInterest1hAgo: 130,
      openInterest4hAgo: 100,
      longShortRatio: 1,
      // El taker de T es el período [T, T + 1 h): todavía no se publicó.
      takerRatio: 0.91,
    })
    expect(snapshots.find((s) => s.at === T + TK)).toMatchObject({ openInterest: 140, takerRatio: 0.9 })
  })

  it('es causal: el taker de T no se ve a T + 1 h + 4 min y sí a T + 1 h + 5 min', () => {
    const snapshots = toFuturesSnapshots(hourly())
    expect(seen(snapshots, T + H + 4 * MIN)?.takerRatio).toBe(0.91)
    expect(seen(snapshots, T + TK)?.takerRatio).toBe(0.9)
  })

  it('es causal: el OI y el long/short de T no se ven en T sino a los 5 min', () => {
    const snapshots = toFuturesSnapshots(hourly())
    expect(seen(snapshots, T)).toMatchObject({ openInterest: 130, longShortRatio: 1.1 })
    expect(seen(snapshots, T + L - 1)).toMatchObject({ openInterest: 130, longShortRatio: 1.1 })
    expect(seen(snapshots, T + L)).toMatchObject({ openInterest: 140, longShortRatio: 1 })
  })

  it('es causal: cada snapshot sólo ve lo ya disponible', () => {
    const funding = point(T - H / 2, { fundingRate: 0.0001, nextFundingTime: T + 4 * H })
    const snapshots = toFuturesSnapshots([...hourly(), funding])
    const halfHourBefore = snapshots.find((s) => s.at === T - H / 2)
    // El OI vigente es el de T−1h; hace 1 h es el de T−2h; hace 4 h (T−5h) no existe.
    expect(halfHourBefore).toMatchObject({ openInterest: 130, openInterest1hAgo: 120, openInterest4hAgo: null, fundingRate: 0.0001, takerRatio: 0.92 })
    expect(snapshots[0]).toMatchObject({ at: T - 4 * H + L, openInterest: 100, openInterest1hAgo: null, takerRatio: null, fundingRate: null, nextFundingTime: null })
  })

  it('si falta el punto de hace 1 h no usa uno más viejo', () => {
    const last = toFuturesSnapshots(hourly([1])).find((s) => s.at === T + L)
    expect(last).toMatchObject({ openInterest: 140, openInterest1hAgo: null, openInterest4hAgo: 100 })
  })

  it('OI y ratios con más de dos horas desde que llegaron quedan en null; el funding vigente se arrastra', () => {
    expect(FUTURES_MAX_AGE_MS).toBe(2 * H)
    const funding = point(T, { fundingRate: 0.0002, nextFundingTime: T + 8 * H })
    const later = point(T + 3 * H + TK, { nextFundingTime: T + 8 * H })
    const snapshots = toFuturesSnapshots([...hourly(), funding, later])
    expect(snapshots.at(-1)).toEqual({
      at: T + 3 * H + TK,
      fundingRate: 0.0002,
      nextFundingTime: T + 8 * H,
      openInterest: null,
      openInterest1hAgo: null,
      openInterest4hAgo: null,
      longShortRatio: null,
      takerRatio: null,
    })
    // Justo a las dos horas de llegar todavía vale.
    const atLimit = toFuturesSnapshots([...hourly(), point(T + L + 2 * H, { fundingRate: 0.0002 })]).find((s) => s.at === T + L + 2 * H)
    expect(atLimit).toMatchObject({ openInterest: 140, openInterest1hAgo: 130, longShortRatio: 1, takerRatio: 0.9 })
    const takerAtLimit = toFuturesSnapshots([...hourly(), point(T + TK + 2 * H, { fundingRate: 0.0002 })]).find((s) => s.at === T + TK + 2 * H)
    expect(takerAtLimit).toMatchObject({ openInterest: null, longShortRatio: null, takerRatio: 0.9 })
  })

  it('si dejan de llegar filas, un snapshot al vencer da OI y ratios por faltantes', () => {
    // `buildMarketView` toma el último snapshot ≤ t sin mirar su edad: sin este punto,
    // el OI de T seguiría vigente para siempre si se cortan el sondeo y el stream.
    const funding = point(T, { fundingRate: 0.0002, nextFundingTime: T + 8 * H })
    const snapshots = toFuturesSnapshots([...hourly(), funding])
    const oiExpiry = T + L + FUTURES_MAX_AGE_MS + 1
    const takerExpiry = T + TK + FUTURES_MAX_AGE_MS + 1
    expect(snapshots.find((s) => s.at === oiExpiry)).toMatchObject({ openInterest: null, openInterest1hAgo: null, longShortRatio: null, takerRatio: 0.9 })
    expect(snapshots.at(-1)).toEqual({
      at: takerExpiry,
      fundingRate: 0.0002,
      nextFundingTime: T + 8 * H,
      openInterest: null,
      openInterest1hAgo: null,
      openInterest4hAgo: null,
      longShortRatio: null,
      takerRatio: null,
    })
    // Una sola vez por vencimiento: los valores que se renuevan a tiempo no agregan puntos.
    expect(snapshots.filter((s) => s.at > T + TK)).toHaveLength(2)
  })

  it('cada serie vence por su lado: el ratio viejo se va y el OI nuevo sigue', () => {
    const snapshots = toFuturesSnapshots([
      point(T, { openInterest: 100, longShortRatio: 1.2 }),
      point(T + H, { openInterest: 110 }),
      point(T + 2 * H, { openInterest: 120 }),
    ])
    expect(snapshots.map((s) => s.at)).toEqual([T + L, T + H + L, T + 2 * H + L, T + L + FUTURES_MAX_AGE_MS + 1, T + 2 * H + L + FUTURES_MAX_AGE_MS + 1])
    expect(snapshots[3]).toMatchObject({ openInterest: 120, openInterest1hAgo: 110, longShortRatio: null })
    expect(snapshots[4]).toMatchObject({ openInterest: null, longShortRatio: null })
  })

  it('sin puntos no hay snapshots y rechaza mezclar símbolos', () => {
    expect(toFuturesSnapshots([])).toEqual([])
    expect(() => toFuturesSnapshots([point(T), point(T + H, { symbol: 'ETHUSDT' })])).toThrow(RangeError)
  })
})
