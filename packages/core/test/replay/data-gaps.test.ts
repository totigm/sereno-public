import { describe, expect, it } from 'vitest'
import { runReplay } from '../../src/replay/replay-runner'
import type { Candle, EngineEvent } from '../../src/types'
import { ofType } from '../engine/fixtures'
import { enterAt, HOUR, MIN15, START, SYMBOL, syntheticData, syntheticInput } from './synthetic'

// Huecos en los datos de precio de marca: el replay los cubre con el mejor dato que tiene
// y los informa, en vez de absorberlos en silencio.

describe('replay — velas de marca que faltan', () => {
  it('se listan en tramos por moneda: ahí stops, take profit y liquidación dispararon con el último precio', async () => {
    const decision = START + HOUR
    const to = decision + 4 * MIN15
    const gap = new Set([decision + MIN15, decision + 2 * MIN15])
    const editMark15m = (c: Candle): Candle | null => (gap.has(c.openTime) ? null : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, editMark15m }), { to, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.missingMarkWindows).toEqual([{ symbol: SYMBOL, from: decision + MIN15, to: decision + 2 * MIN15, decisions: 2 }])
  })

  it('con todas las velas de marca no hay tramos', async () => {
    const to = START + 2 * HOUR
    const result = await runReplay(syntheticInput(syntheticData({ to }), { to, sink: () => undefined }))
    expect(result.missingMarkWindows).toEqual([])
  })
})

describe('replay — funding sin precio de marca', () => {
  it('se cobra con la apertura de la vela de marca de su instante, no se pierde como falla', async () => {
    const decision = START + HOUR
    const fundingSlot = decision + HOUR
    const to = fundingSlot + MIN15
    // La marca de esa vela (104) difiere del último precio (100): el cobro tiene que usar la marca.
    const editMark15m = (c: Candle): Candle => (c.openTime === fundingSlot ? { ...c, open: 104, high: 104.2, low: 103.8, close: 104 } : c)
    const data = { ...syntheticData({ to, editMark15m }), funding: { [SYMBOL]: [{ symbol: SYMBOL, at: fundingSlot + 3, rate: 0.001, markPrice: Number.NaN }] } }
    const events: EngineEvent[] = []
    const result = await runReplay(syntheticInput(data, { to, scorer: enterAt(decision), sink: (e) => events.push(e) }))
    const [opened] = ofType(events, 'position_opened')
    const [funded] = ofType(events, 'funding_applied')
    expect(funded).toMatchObject({ positionId: opened?.position.id, at: fundingSlot + 3 })
    expect(funded?.amount).toBeCloseTo(-(opened?.position.qty ?? 0) * 104 * 0.001, 12)
    expect(result.failures).toEqual([])
  })

  it('sin ninguna vela en su instante queda como falla del motor', async () => {
    const to = START + 2 * HOUR
    const fundingAt = START + HOUR
    // Los datos de SOL terminan antes del funding: no hay de dónde sacar la marca.
    const data = { ...syntheticData({ to, dataEnd: fundingAt }), funding: { [SYMBOL]: [{ symbol: SYMBOL, at: fundingAt, rate: 0.001, markPrice: 0 }] } }
    const result = await runReplay(syntheticInput(data, { to, sink: () => undefined }))
    expect(result.failures).toEqual([expect.objectContaining({ operation: 'funding', symbol: SYMBOL, at: fundingAt })])
  })
})
