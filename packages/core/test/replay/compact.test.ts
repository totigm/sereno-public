import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { CandleSeries } from '../../src/market/candle-series'
import { compactReplayData, compactSymbol, firstViewBySymbol } from '../../src/replay/compact'
import { type CandleList, PackedCandles, PackedSeries } from '../../src/replay/packed-candles'
import { runReplay } from '../../src/replay/replay-runner'
import type { ReplayData } from '../../src/replay/types'
import type { Candle, EngineEvent } from '../../src/types'
import { scenarioLearningState } from '../engine/fixtures'
import { MINI_FROM, MINI_TO, miniData } from './mini-fixture'

const M15 = 15 * 60_000
const DAY = 86_400_000

function candle(openTime: number, close: number, closed = true): Candle {
  return { openTime, closeTime: openTime + M15 - 1, open: close - 1, high: close + 1, low: close - 2, close, volume: 3, quoteVolume: 3 * close, closed }
}

describe('PackedCandles', () => {
  it('ordena por apertura, deja la última de dos con la misma apertura y devuelve las velas como estaban', () => {
    const a = candle(2 * M15, 10)
    const b = candle(0, 11, false)
    const c = candle(2 * M15, 12)
    const packed = PackedCandles.from([a, b, c])
    expect(packed.toArray()).toEqual([b, c])
    expect(Object.keys(packed.at(0))).toEqual(Object.keys(a))
    expect(packed.indexOf(2 * M15)).toBe(1)
    expect(packed.indexOf(M15)).toBe(-1)
    expect(packed.from(1).toArray()).toEqual([c])
  })

  it('`closedUpTo` lee lo mismo que `CandleSeries` con huecos y velas abiertas', () => {
    const candles: Candle[] = []
    for (let i = 0; i < 1500; i++) if (i % 7 !== 3) candles.push(candle(i * M15, 100 + i, i % 11 !== 5))
    const series = new CandleSeries('15m')
    for (const c of candles) series.upsert(c)
    const packed = new PackedSeries(PackedCandles.from(candles))
    for (const t of [-1, 0, M15 - 1, M15, 700 * M15 + 5, 1499 * M15, 2000 * M15]) {
      for (const limit of [1, 5, 300, Number.POSITIVE_INFINITY]) expect(packed.closedUpTo(t, limit)).toEqual(series.closedUpTo(t, limit))
    }
    // Las vistas de instantes seguidos comparten los objetos de las velas.
    const before = packed.closedUpTo(900 * M15, 300)
    const after = packed.closedUpTo(901 * M15, 300)
    expect(after[0]).toBe(before[1])
  })
})

// El mini con ETH recién desde el tercer día (BTC sale el cuarto con abiertas que se
// mantienen), un hueco en su calentamiento y fundings sin marca antes de que entre.
const HOUR = 3_600_000
const ENTER = MINI_FROM + 4 * DAY
// Sin la vela de marca: su funding se cobra con la de último precio.
const NO_MARK = MINI_FROM + 8 * HOUR
const inGap = (t: number): boolean => t >= ENTER - 9 * HOUR && t < ENTER - HOUR

function lateEntryData(): ReplayData {
  const data = miniData()
  for (const [day, symbols] of Object.entries(data.symbolsByDay)) {
    if (Date.parse(day) < ENTER) data.symbolsByDay[day] = symbols.filter((s) => s !== 'ETHUSDT')
  }
  const eth = data.candles.ETHUSDT!
  eth['15m'].last = eth['15m'].last.filter((c) => !inGap(c.openTime))
  eth['15m'].mark = eth['15m'].mark.filter((c) => !inGap(c.openTime) && c.openTime !== NO_MARK)
  eth['1h'].last = eth['1h'].last.filter((c) => !inGap(c.openTime))
  // Uno de cada tres sin marca, más el de la vela sin marca y el del hueco (ese, sin ninguna
  // vela, queda como falla del motor).
  data.funding.ETHUSDT = data.funding.ETHUSDT!.map((e, i) => {
    const open = e.at - (e.at % M15)
    return i % 3 === 0 || open === NO_MARK || inGap(open) ? { ...e, markPrice: Number.NaN } : e
  })
  // Velas de marca de 1h y 4h, que nadie lee.
  eth['1h'].mark = eth['1h'].last
  eth['4h'].mark = eth['4h'].last
  return data
}

async function run(data: ReplayData<CandleList>) {
  const events: EngineEvent[] = []
  const result = await runReplay({
    ...data,
    id: 'compact',
    settings: DEFAULT_SETTINGS,
    learningInit: scenarioLearningState(MINI_FROM),
    capital: 1_000,
    from: MINI_FROM,
    to: MINI_TO,
    paramTuning: false,
    reliability: true,
    sink: (e) => events.push(e),
  })
  return { result: JSON.stringify(result), events: JSON.stringify(events), failures: result.failures, closed: result.closed }
}

describe('compactReplayData', () => {
  it('corta cada moneda en su calentamiento antes de entrar al universo y deja sólo la marca de 15m', () => {
    const data = lateEntryData()
    const compact = compactReplayData(data)
    const eth = compact.candles.ETHUSDT!
    expect(firstViewBySymbol(data.symbolsByDay).get('ETHUSDT')).toBe(ENTER)
    for (const tf of ['15m', '1h', '4h'] as const) {
      expect(eth[tf].last.length).toBeLessThan(data.candles.ETHUSDT![tf].last.length)
      expect(eth[tf].last.openTime.at(-1)).toBe(data.candles.ETHUSDT![tf].last.at(-1)!.openTime)
    }
    expect(eth['1h'].mark.length).toBe(0)
    expect(eth['4h'].mark.length).toBe(0)
    expect(eth['15m'].mark.openTime[0]).toBeGreaterThanOrEqual(eth['15m'].last.openTime[0]!)
    // BTC está desde el primer día: sólo se empaqueta.
    expect(compact.candles.BTCUSDT!['15m'].last.length).toBe(data.candles.BTCUSDT!['15m'].last.length)
  })

  it('el replay sobre el mercado compactado da el mismo resultado y los mismos eventos, byte a byte', async () => {
    const data = lateEntryData()
    const full = await run(data)
    const compact = await run(compactReplayData(lateEntryData()))
    expect(compact.result).toBe(full.result)
    expect(compact.events).toBe(full.events)
    // Que el test valga algo: ETH operó, y un funding sin ninguna vela quedó como falla.
    expect(full.closed.real.some((p) => p.symbol === 'ETHUSDT')).toBe(true)
    expect(full.failures.some((f) => f.operation === 'funding' && f.symbol === 'ETHUSDT')).toBe(true)
  })

  it('compactSymbol resuelve el funding sin marca con la serie entera, aunque caiga antes del corte', () => {
    const data = lateEntryData()
    const { funding } = compactSymbol(data.candles.ETHUSDT!, data.funding.ETHUSDT!, ENTER)
    const last = data.candles.ETHUSDT!['15m'].last.find((c) => c.openTime === NO_MARK)!
    expect(funding.find((e) => e.at - (e.at % M15) === NO_MARK)?.markPrice).toBe(last.open)
    expect(funding.filter((e) => Number.isNaN(e.markPrice)).map((e) => e.at)).toEqual([ENTER - 8 * HOUR])
  })
})
