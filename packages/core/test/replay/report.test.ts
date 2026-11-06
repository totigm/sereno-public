import { describe, expect, it } from 'vitest'
import { Coverage } from '../../src/replay/coverage'
import { CalibrationReport } from '../../src/replay/report'
import type { Decision, DecisionAction, SignalId } from '../../src/types'
import { compositeOf } from '../engine/fixtures'

const MIN15 = 15 * 60_000
const T0 = Date.UTC(2026, 9, 1)
const WAIT: DecisionAction = { kind: 'wait' }
const NO_CANDLE: DecisionAction = { kind: 'blocked', reason: 'no_candle', wantedSide: null }

// El reporte y la cobertura se arman sobre la marcha, decisión por decisión.
function calibrated(decisions: readonly Decision[]): CalibrationReport {
  const report = new CalibrationReport()
  for (const d of decisions) report.add(d)
  return report
}

function covered(decisions: readonly Decision[], days: readonly string[] = [], markFallback: (symbol: string, t: number) => boolean = () => false): Coverage {
  const coverage = new Coverage(days, markFallback)
  for (const d of decisions) coverage.add(d)
  return coverage
}

function decision(t: number, symbol: string, Sprime: number, options: { values?: Partial<Record<SignalId, number>>; missing?: SignalId[]; action?: DecisionAction } = {}): Decision {
  const signals = Object.entries(options.values ?? {}).map(([id, value]) => ({ id: id as SignalId, value }))
  return { t, symbol, composite: compositeOf(Sprime, { signals, missing: options.missing ?? [] }), action: options.action ?? WAIT }
}

describe('CalibrationReport — histograma de S′', () => {
  it('40 barras de 0,05 entre −1 y +1; los bordes caen en la barra que empiezan, +1 en la última', () => {
    const bins = calibrated([decision(T0, 'A', 0.35), decision(T0, 'B', -0.9), decision(T0, 'C', 1), decision(T0, 'D', -1), decision(T0, 'E', 0.3499)]).histogram()
    expect(bins).toHaveLength(40)
    expect(bins[0]).toEqual({ from: -1, to: -0.95, count: 1 })
    expect(bins.find((b) => b.from === -0.9)?.count).toBe(1)
    expect(bins.find((b) => b.from === 0.35)?.count).toBe(1)
    expect(bins.find((b) => b.from === 0.3)?.count).toBe(1)
    expect(bins.at(-1)).toEqual({ from: 0.95, to: 1, count: 1 })
  })

  it('no cuenta las decisiones sin vela: su S′ es de una vista vieja', () => {
    const bins = calibrated([decision(T0, 'A', 0.5, { action: NO_CANDLE }), decision(T0, 'B', 0.5)]).histogram()
    expect(bins.reduce((acc, b) => acc + b.count, 0)).toBe(1)
  })
})

describe('CalibrationReport — correlación entre señales', () => {
  it('Pearson por par sobre las decisiones donde las dos señales tenían dato', () => {
    const decisions = [
      decision(T0, 'A', 0, { values: { trend15m: 1, momentum: 0.5, bands: -1 } }),
      decision(T0, 'B', 0, { values: { trend15m: -1, momentum: -0.5, bands: 1 } }),
      decision(T0, 'C', 0, { values: { trend15m: 0.5, momentum: 0.25, bands: -0.5, funding: 0.3 } }),
    ]
    const { signals, rho, pairs } = calibrated(decisions).correlation()
    const at = (a: SignalId, b: SignalId) => rho[signals.indexOf(a)]?.[signals.indexOf(b)]
    expect(at('trend15m', 'momentum')).toBeCloseTo(1, 12)
    expect(at('trend15m', 'bands')).toBeCloseTo(-1, 12)
    expect(at('trend15m', 'trend15m')).toBe(1)
    // funding tiene un solo dato: sin correlación.
    expect(at('funding', 'trend15m')).toBeNull()
    expect(pairs[signals.indexOf('funding')]?.[signals.indexOf('trend15m')]).toBe(1)
    expect(at('vwap', 'vwap')).toBeNull()
  })
})

describe('Coverage — señales que faltan', () => {
  it('un tramo por moneda y señal mientras falta en velas consecutivas', () => {
    const decisions = [0, 1, 2, 3, 5].flatMap((i) => [
      decision(T0 + i * MIN15, 'ETHUSDT', 0, { missing: i < 2 || i === 5 ? ['openInterest'] : [] }),
      decision(T0 + i * MIN15, 'BTCUSDT', 0, { missing: ['funding', 'openInterest'] }),
    ])
    expect(covered(decisions).missingSignalWindows()).toEqual([
      // BTC dejó de decidir en la vela 4: el tramo se corta ahí aunque la señal siga faltando.
      { signal: 'funding', symbol: 'BTCUSDT', from: T0, to: T0 + 3 * MIN15, decisions: 4 },
      { signal: 'funding', symbol: 'BTCUSDT', from: T0 + 5 * MIN15, to: T0 + 5 * MIN15, decisions: 1 },
      { signal: 'openInterest', symbol: 'BTCUSDT', from: T0, to: T0 + 3 * MIN15, decisions: 4 },
      { signal: 'openInterest', symbol: 'BTCUSDT', from: T0 + 5 * MIN15, to: T0 + 5 * MIN15, decisions: 1 },
      { signal: 'openInterest', symbol: 'ETHUSDT', from: T0, to: T0 + MIN15, decisions: 2 },
      { signal: 'openInterest', symbol: 'ETHUSDT', from: T0 + 5 * MIN15, to: T0 + 5 * MIN15, decisions: 1 },
    ])
  })
})

describe('Coverage — universo por día', () => {
  it('las monedas con decisión de cada día en el orden en que aparecieron; un día sin decisiones queda vacío', () => {
    const day2 = T0 + 86_400_000
    const decisions = [decision(T0, 'ETHUSDT', 0), decision(T0, 'BTCUSDT', 0), decision(T0 + MIN15, 'ETHUSDT', 0), decision(day2, 'SOLUSDT', 0)]
    expect(covered(decisions, ['2026-10-01', '2026-10-02', '2026-10-03']).universeByDay()).toEqual({
      '2026-10-01': ['ETHUSDT', 'BTCUSDT'],
      '2026-10-02': ['SOLUSDT'],
      '2026-10-03': [],
    })
  })
})

describe('Coverage — velas de marca que faltan', () => {
  it('un tramo por moneda mientras decide en velas consecutivas sin vela de marca', () => {
    const missing = new Set([`BTCUSDT|${T0 + MIN15}`, `BTCUSDT|${T0 + 2 * MIN15}`, `ETHUSDT|${T0 + 3 * MIN15}`, `BTCUSDT|${T0 + 5 * MIN15}`])
    const decisions = [0, 1, 2, 3, 5].flatMap((i) => [decision(T0 + i * MIN15, 'ETHUSDT', 0), decision(T0 + i * MIN15, 'BTCUSDT', 0)])
    expect(covered(decisions, [], (symbol, t) => missing.has(`${symbol}|${t}`)).missingMarkWindows()).toEqual([
      { symbol: 'BTCUSDT', from: T0 + MIN15, to: T0 + 2 * MIN15, decisions: 2 },
      { symbol: 'BTCUSDT', from: T0 + 5 * MIN15, to: T0 + 5 * MIN15, decisions: 1 },
      { symbol: 'ETHUSDT', from: T0 + 3 * MIN15, to: T0 + 3 * MIN15, decisions: 1 },
    ])
  })
})
