import { describe, expect, it } from 'vitest'
import type { Scorer } from '../../src/engine/types'
import { runReplay } from '../../src/replay/replay-runner'
import { maxDrawdown } from '../../src/stats/stats'
import type { Candle, Decision, EngineEvent } from '../../src/types'
import { compositeOf, ofType } from '../engine/fixtures'
import { enterAt, HOUR, MIN, MIN15, START, SYMBOL, syntheticData, syntheticInput } from './synthetic'

// Regla de causalidad (spec §5.2) y fills del replay (spec §6) sobre un mercado plano.

// Vela de 4h 08:00–12:00 con un salto del 10%: cierra a las 11:59:59,999.
const PUMP = (c: Candle): Candle => (c.openTime === START ? { ...c, open: 100, high: 111, low: 99, close: 110 } : c)
// Entra en long cuando la última vela de 4h que ve es un salto.
const pumpScorer: Scorer = (view, weights) => {
  const last = view.candles['4h'].at(-1)
  const pumped = last !== undefined && last.close >= last.open * 1.05
  return { ...compositeOf(pumped ? 0.8 : 0), weights: { ...weights } }
}

async function decisionsWith(edit4h: (c: Candle) => Candle | null): Promise<Decision[]> {
  const to = START + 4 * HOUR + MIN15
  const result = await runReplay(syntheticInput(syntheticData({ to, edit4h }), { to, scorer: pumpScorer, sink: () => undefined }))
  return result.decisions
}

const before = (decisions: Decision[], t: number) => decisions.filter((d) => d.t < t)
const entries = (decisions: Decision[]) => decisions.filter((d) => d.action.kind === 'enter').map((d) => d.t)

describe('replay — fuga de futuro', () => {
  it('la vela de 4h en curso no se ve: hasta su cierre se decide igual que si no existiera', async () => {
    const withCandle = await decisionsWith(PUMP)
    const withoutCandle = await decisionsWith((c) => (c.openTime === START ? null : c))
    const close = START + 4 * HOUR
    expect(before(withCandle, close)).toHaveLength(16)
    expect(before(withCandle, close)).toEqual(before(withoutCandle, close))
    expect(entries(before(withCandle, close))).toEqual([])
    // Al cierre (12:00) la vela ya es historia y la entrada aparece; sin ella, no.
    expect(entries(withCandle)).toEqual([close])
    expect(entries(withoutCandle)).toEqual([])
  })

  it('esa misma vela, vista antes de tiempo, habría cambiado la decisión', async () => {
    // Datos corruptos a propósito: la vela de 4h "cerrada" a las 10:00.
    const leaked = await decisionsWith((c) => (c.openTime === START ? { ...PUMP(c), closeTime: START + 2 * HOUR - 1 } : c))
    expect(entries(leaked)[0]).toBe(START + 2 * HOUR)
  })
})

describe('replay — fills y salidas por el camino de la vela', () => {
  it('decide al cierre de una vela y llena a la apertura de la siguiente, nunca a su cierre', async () => {
    const decision = START + HOUR
    const to = decision + MIN15
    // La vela de decisión cierra en 100 y la siguiente abre con un gap en 101.
    const edit15m = (c: Candle): Candle => (c.openTime === decision ? { ...c, open: 101, high: 101.2, low: 100.8, close: 101 } : c)
    const events: EngineEvent[] = []
    await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, scorer: enterAt(decision), sink: (e) => events.push(e) }))
    const [real, shadow] = ofType(events, 'position_opened')
    expect(real?.position).toMatchObject({ symbol: SYMBOL, entryPrice: 101, openedAt: decision, shadow: false, id: `replay-causal-real-${SYMBOL}-${decision}` })
    expect(shadow?.position).toMatchObject({ entryPrice: 101, shadow: true })
  })

  it('un stop tocado dentro de la vela cierra en el stop, en el extremo adverso del camino', async () => {
    const decision = START + HOUR
    const next = decision + MIN15
    const to = next + MIN15
    const edit15m = (c: Candle): Candle => (c.openTime === next ? { ...c, open: 100, high: 100.4, low: 96, close: 96.5 } : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    // ATR 2 con k 1,5: stop al 3%, en 97.
    expect(result.closed.real).toHaveLength(1)
    expect(result.closed.real[0]).toMatchObject({ closeReason: 'stop', exitPrice: 97, closedAt: next + 5 * MIN })
  })

  it('la vela en que llena una entrada también se recorre por dentro: un stop en esa misma vela la cierra', async () => {
    const decision = START + HOUR
    const to = decision + MIN15
    // La entrada llena en la apertura (100) de la vela que empieza en `decision`, y esa vela baja a 96.
    const edit15m = (c: Candle): Candle => (c.openTime === decision ? { ...c, open: 100, high: 100.4, low: 96, close: 96.5 } : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.closed.real).toHaveLength(1)
    expect(result.closed.real[0]).toMatchObject({ openedAt: decision, entryPrice: 100, closeReason: 'stop', exitPrice: 97, closedAt: decision + 5 * MIN })
    expect(result.closed.shadow[0]).toMatchObject({ openedAt: decision, closeReason: 'stop', closedAt: decision + 5 * MIN })
  })

  it('el drawdown por vela es el peor caso: cuenta la caída hasta el extremo adverso aunque la vela cierre arriba', async () => {
    const decision = START + HOUR
    const next = decision + MIN15
    const to = next + MIN15
    const edit15m = (c: Candle): Candle => (c.openTime === next ? { ...c, open: 100, high: 100.6, low: 97.5, close: 100.5 } : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    const [position] = result.open.real
    if (!position) throw new Error('sin abierta')
    const closes = result.equity.map((p) => ({ at: p.at, equity: p.real.equity }))
    expect(maxDrawdown(closes).pct).toBe(0)
    expect(result.stats.real.maxDrawdownPct).toBeCloseTo((2.5 * position.qty) / 1_000, 9)
  })

  it('una moneda sin más velas con una abierta se cierra como deslistada al último precio', async () => {
    const decision = START + HOUR
    const dataEnd = decision + HOUR
    const to = dataEnd + 2 * MIN15
    const edit15m = (c: Candle): Candle => (c.openTime === dataEnd - MIN15 ? { ...c, close: 100.3 } : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, dataEnd, edit15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.closed.real).toHaveLength(1)
    expect(result.closed.real[0]).toMatchObject({ closeReason: 'delisted', exitPrice: 100.3, closedAt: dataEnd })
    expect(result.open.real).toEqual([])
  })

  it('el funding se cobra en su `at` con su marca, antes de la decisión de esa vela', async () => {
    const decision = START + HOUR
    const fundingAt = decision + HOUR + 3
    const to = decision + HOUR + MIN15
    const events: EngineEvent[] = []
    const data = { ...syntheticData({ to }), funding: { [SYMBOL]: [{ symbol: SYMBOL, at: fundingAt, rate: 0.001, markPrice: 105 }] } }
    await runReplay(syntheticInput(data, { to, scorer: enterAt(decision), sink: (e) => events.push(e) }))
    const [opened] = ofType(events, 'position_opened')
    const funded = ofType(events, 'funding_applied')
    expect(funded).toHaveLength(2)
    expect(funded[0]).toMatchObject({ positionId: opened?.position.id, at: fundingAt })
    expect(funded[0]?.amount).toBeCloseTo(-(opened?.position.qty ?? 0) * 105 * 0.001, 12)
    const fundingIndex = events.indexOf(funded[0]!)
    const decisionsIndex = events.findIndex((e) => e.type === 'decisions' && e.t === decision + HOUR)
    expect(fundingIndex).toBeLessThan(decisionsIndex)
  })

  it('sin la vela que cierra en t la moneda decide "sin vela"', async () => {
    const decision = START + HOUR
    const to = decision + MIN15
    const edit15m = (c: Candle): Candle | null => (c.openTime === decision - MIN15 ? null : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.decisions.at(-1)).toMatchObject({ t: decision, action: { kind: 'blocked', reason: 'no_candle', wantedSide: 'long' } })
    expect(result.closed.real).toEqual([])
    expect(result.open.real).toEqual([])
  })
})
