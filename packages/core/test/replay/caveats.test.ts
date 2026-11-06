import { describe, expect, it } from 'vitest'
import type { Scorer } from '../../src/engine/types'
import { runReplay } from '../../src/replay/replay-runner'
import type { Candle } from '../../src/types'
import { compositeOf, settingsWith, scenarioLearningState } from '../engine/fixtures'
import { enterAt, HOUR, MIN, MIN15, START, syntheticData, syntheticInput } from './synthetic'

// Lo que el reporte del replay tiene que declarar porque el replay no pudo ser fiel o
// peor caso: la pausa por drawdown que nadie levanta y la sombra del lado contrario.

describe('replay — pausa por drawdown máximo', () => {
  const decision = START + HOUR
  const next = decision + MIN15
  // Pasado el enfriamiento de la moneda (4 velas después del stop).
  const later = next + 2 * HOUR
  const to = later + MIN15
  // Con un drawdown máximo de 0,5%, el stop de una entrada (1% de riesgo) lo dispara.
  const settings = settingsWith({ risk: { maxDrawdown: 0.005 } })

  it('queda en el resultado con su instante: desde ahí lo real no abre más y la sombra sigue', async () => {
    const edit15m = (c: Candle): Candle => (c.openTime === next ? { ...c, open: 100, high: 100.4, low: 96, close: 96.5 } : c)
    const result = await runReplay(syntheticInput(syntheticData({ to, edit15m }), { to, settings, scorer: enterAt(decision, later), sink: () => undefined }))
    const [stopped] = result.closed.real
    if (!stopped) throw new Error('el stop no cerró la entrada')
    expect(result.caveats.drawdownPause).toMatchObject({ at: next + 5 * MIN, peak: 1_000 })
    // Sin costos: la equity es el capital menos los 3 de precio del stop por la cantidad.
    expect(result.caveats.drawdownPause?.equity).toBeCloseTo(1_000 - 3 * stopped.qty, 9)
    const after = result.decisions.find((d) => d.t === later)
    expect(after?.action).toMatchObject({ kind: 'blocked', reason: 'drawdown_pause' })
    expect(after?.shadow?.action).toBe('enter')
  })

  it('sin drawdown queda en null', async () => {
    const result = await runReplay(syntheticInput(syntheticData({ to }), { to, settings, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.caveats.drawdownPause).toBeNull()
  })
})

describe('replay — sombra del lado contrario a lo real', () => {
  const decision = START + HOUR
  const to = decision + 2 * MIN15

  it('cuenta las velas recorridas en el orden de lo real con la sombra abierta del otro lado', async () => {
    // Lo real pesa trend15m doble y la sombra decide con pesos 1: el puntaje los manda a lados opuestos.
    const base = scenarioLearningState(START)
    const learningInit = { ...base, weightsGlobal: { ...base.weightsGlobal, trend15m: 2 } }
    const scorer: Scorer = (view, weights) => ({ ...compositeOf(view.t === decision ? (weights.trend15m === 1 ? 0.8 : -0.8) : 0), weights: { ...weights } })
    const result = await runReplay(syntheticInput(syntheticData({ to }), { to, learningInit, scorer, sink: () => undefined }))
    expect(result.open.real.map((p) => p.side)).toEqual(['short'])
    expect(result.open.shadow.map((p) => p.side)).toEqual(['long'])
    // La vela en que llenaron y la siguiente.
    expect(result.caveats.shadowOppositeSideCandles).toBe(2)
  })

  it('del mismo lado no cuenta', async () => {
    const result = await runReplay(syntheticInput(syntheticData({ to }), { to, scorer: enterAt(decision), sink: () => undefined }))
    expect(result.open.real).toHaveLength(1)
    expect(result.open.shadow).toHaveLength(1)
    expect(result.caveats.shadowOppositeSideCandles).toBe(0)
  })
})
