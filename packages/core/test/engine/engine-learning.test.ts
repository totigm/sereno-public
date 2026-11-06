import { describe, expect, it } from 'vitest'
import type { Scorer } from '../../src/engine/types'
import { signalRecord } from '../../src/learning/state'
import { effectiveWeights } from '../../src/learning/weights'
import type { LearningState, SignalId } from '../../src/types'
import { compositeOf, DAY, harness, MIN, NO_CONTEXT, ofType, settingsWith, T, tableScorer, tick, viewOf, weightedScorer, scenarioLearningState } from './fixtures'

// Estado con el trade 50 por cerrar: el primero que ya mueve pesos.
const READY: LearningState = { ...scenarioLearningState(T), closedTrades: 49 }

async function loseOnSol(learning: LearningState, frozen = false) {
  const h = harness({ settings: settingsWith({ learning: { frozen } }), learning, scorer: tableScorer({ SOLUSDT: 0.6 }) })
  await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
  await h.engine.onMarkTick(tick('SOLUSDT', 96.9, T + 5 * MIN))
  return h
}

describe('TradingEngine — aprendizaje de los trades reales', () => {
  it('un trade real cerrado mueve pesos y confianza y emite learning_updated con su muestra y el antes/después', async () => {
    const h = await loseOnSol(READY)
    const updates = ofType(h.events, 'learning_updated')
    expect(updates.map((u) => [u.kind, u.symbol, u.sampleSize])).toEqual([
      ['weight_trade', 'SOLUSDT', 50],
      ['confidence', 'SOLUSDT', 1],
    ])
    const [weights, confidence] = updates
    expect(weights?.before).toEqual({ trendHigher: { global: 1, symbol: 1 }, funding: { global: 1, symbol: 1 } })
    expect(weights?.message).toBe('Trade 50 en SOLUSDT (long, −1,03R): bajé trendHigher, funding (n = 50).')
    expect(weights?.phrase).toBe('Trade 50 en SOL (long, −1,03R): bajé el peso de la tendencia mayor y del funding (n = 50).')
    expect(confidence?.after).toEqual({ confidence: expect.closeTo(0.2 * (-8.68 / 8.4 / 2), 9) })
    const learning = h.engine.snapshot().learning
    expect(learning.closedTrades).toBe(50)
    expect(learning.weightsGlobal.trendHigher).toBeLessThan(1)
    expect(learning.confidenceBySymbol['SOLUSDT']).toBeLessThan(0)
    // learning_updated sale después del cierre que lo explica.
    expect(h.events.findIndex((e) => e.type === 'position_closed')).toBeLessThan(h.events.findIndex((e) => e.type === 'learning_updated'))
  })

  it('con el aprendizaje congelado el trade cuenta pero no cambia pesos ni confianza', async () => {
    const h = await loseOnSol(READY, true)
    expect(ofType(h.events, 'learning_updated')).toEqual([])
    const learning = h.engine.snapshot().learning
    expect(learning.weightsGlobal).toEqual(signalRecord(1))
    expect(learning.confidenceBySymbol).toEqual({})
    expect(learning.closedTrades).toBe(50)
    expect(learning.tradesBySymbol).toEqual({ SOLUSDT: 1 })
  })

  it('effectiveWeights(state, símbolo) alimenta el compuesto de lo aprendido; la sombra usa pesos 1', async () => {
    const learning: LearningState = { ...scenarioLearningState(T), weightsBySymbol: { SOLUSDT: { momentum: 2 } }, tradesBySymbol: { SOLUSDT: 30 } }
    const seen: Record<SignalId, number>[] = []
    const scorer: Scorer = (view, weights) => {
      seen.push(weights)
      return compositeOf(0, { weights })
    }
    const h = harness({ learning, scorer, shadow: true })
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(seen).toEqual([effectiveWeights(learning, 'SOLUSDT', 30), signalRecord(1)])
    // λ = 30 / (30 + 30): mitad global (1) y mitad moneda (2).
    expect(seen[0]?.momentum).toBe(1.5)
  })

  it('mMoneda = symbolMultiplier(state, símbolo, ahora) achica el riesgo de una moneda con confianza baja', async () => {
    const learning: LearningState = { ...scenarioLearningState(T), confidenceBySymbol: { SOLUSDT: -0.3 } }
    const h = harness({ learning, scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    const action = decisions[0]?.action
    expect(action?.kind === 'enter' && action.plan.multipliers).toEqual({ confidence: 0.84, symbol: 0.7, btc: 1 })
    expect(action?.kind === 'enter' && action.plan.riesgoUsd).toBeCloseTo(8.4 * 0.7, 12)
  })

  it('una moneda en penitencia no entra; una penitencia vencida se levanta una vez por ciclo y lo dice', async () => {
    const learning: LearningState = { ...scenarioLearningState(T), penalties: { SOLUSDT: T + DAY, ETHUSDT: T - 1 }, confidenceBySymbol: { SOLUSDT: -0.45, ETHUSDT: -0.45 } }
    const h = harness({ learning, scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.6 }) })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT')], NO_CONTEXT)
    expect(decisions.map((d) => d.action.kind === 'blocked' ? d.action.reason : d.action.kind)).toEqual(['penalty', 'enter'])
    expect(ofType(h.events, 'learning_updated').map((u) => [u.kind, u.symbol])).toEqual([['penalty_released', 'ETHUSDT']])
    const eth = decisions[1]?.action
    expect(eth?.kind === 'enter' && eth.plan.multipliers.symbol).toBe(0.8)
    expect(h.engine.snapshot().learning.penalties).toEqual({ SOLUSDT: T + DAY })
  })

  it('lo real dimensiona y sale con k, tpR y trailingR aprendidos, no con los de los ajustes', async () => {
    const tuned: LearningState = { ...scenarioLearningState(T), params: { theta: 0.35, k: 2, tpR: 3, trailingR: 1.5, since: T } }
    const h = harness({ learning: tuned, scorer: tableScorer({ SOLUSDT: 0.6 }) })
    const { opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    // k 2 con ATR 2 ⇒ stop a 4% (96); tpR 3 ⇒ take profit a 100 × (1 + 3 × 0,04) = 112; riesgo 8,4 / 4 ⇒ qty 2,1.
    expect(opened[0]).toMatchObject({ stopPrice: 96, takeProfitPrice: 112, qty: 2.1 })
    expect(opened[0]?.distanciaStop).toBeCloseTo(0.04, 12)
    // trailingR 1,5 (1R = 4): a 104 el stop va a la entrada; a 108, a 108 − 1,5 × 4 = 102 (con 1,0 sería 104).
    await h.engine.onMarkTick(tick('SOLUSDT', 104, T + MIN))
    await h.engine.onMarkTick(tick('SOLUSDT', 108, T + 2 * MIN))
    expect(ofType(h.events, 'stop_moved').map((e) => e.to)).toEqual([100, 102])
  })

  it('applyLearning reemplaza el estado: los parámetros aprendidos (θ) mandan en la decisión', async () => {
    const h = harness({ scorer: tableScorer({ SOLUSDT: 0.4 }) })
    await h.engine.applyLearning({ ...scenarioLearningState(T), params: { theta: 0.45, k: 1.5, tpR: 2, trailingR: 1, since: T } })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.action).toEqual({ kind: 'wait' })
  })
})

describe('TradingEngine — la sombra', () => {
  // Con los pesos aprendidos SOL no llega a θ (0,35); con pesos 1, sí (S = 0,6, sobre el θ 0,55 por defecto de la sombra).
  const learned: LearningState = { ...scenarioLearningState(T), weightsGlobal: { ...signalRecord(1), trend15m: 2, momentum: 0.2 } }
  const scorer = weightedScorer({ SOLUSDT: { trend15m: 0.2, momentum: 1 } })

  it('la sombra abre con pesos 1 aunque lo aprendido no abra, en su propio exchange', async () => {
    const h = harness({ learning: learned, scorer, shadow: true })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.action).toEqual({ kind: 'wait' })
    expect(decisions[0]?.shadow).toEqual({ Sprime: expect.closeTo(0.6, 12), action: 'enter' })
    expect(opened.map((p) => [p.symbol, p.shadow])).toEqual([['SOLUSDT', true]])
    expect(await h.exchange.getPositions()).toEqual([])
    expect((await h.shadowExchange!.getPositions()).map((p) => p.symbol)).toEqual(['SOLUSDT'])
    const [event] = ofType(h.events, 'position_opened')
    expect(event?.position).toMatchObject({ shadow: true, id: expect.stringContaining('shadow') })
  })

  it('un trade de la sombra nunca toca el aprendizaje real; lleva su propia confianza', async () => {
    const h = harness({ learning: learned, scorer, shadow: true })
    await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    await h.engine.onMarkTick(tick('SOLUSDT', 90, T + 5 * MIN))
    expect(ofType(h.events, 'position_closed').map((e) => [e.position.closeReason, e.position.shadow])).toEqual([['stop', true]])
    expect(ofType(h.events, 'learning_updated')).toEqual([])
    const snapshot = h.engine.snapshot()
    expect(snapshot.learning).toEqual(learned)
    expect(snapshot.shadow?.learning.weightsGlobal).toEqual(signalRecord(1))
    expect(snapshot.shadow?.learning.tradesBySymbol).toEqual({ SOLUSDT: 1 })
    expect(snapshot.shadow?.learning.confidenceBySymbol['SOLUSDT']).toBeLessThan(0)
  })

  it('la sombra decide con θ y salidas por defecto aunque lo aprendido tenga otros parámetros', async () => {
    const tuned: LearningState = { ...scenarioLearningState(T), params: { theta: 0.7, k: 3, tpR: 3, trailingR: 1.5, since: T } }
    const h = harness({ learning: tuned, scorer: tableScorer({ SOLUSDT: 0.6 }), shadow: true })
    const { decisions, opened } = await h.engine.onCandleClose([viewOf('SOLUSDT')], NO_CONTEXT)
    expect(decisions[0]?.action).toEqual({ kind: 'wait' })
    // Por defecto: θ 0,55, k 2 (stop a 4% con ATR 2) y tpR 2.
    expect(opened[0]).toMatchObject({ shadow: true, thetaAtOpen: 0.55, stopPrice: 96, takeProfitPrice: 108 })
  })

  it('la sombra sigue sus propias reglas de capacidad sobre su propia cuenta', async () => {
    const h = harness({ settings: settingsWith({ risk: { maxPositions: 1 } }), scorer: tableScorer({ SOLUSDT: 0.6, ETHUSDT: 0.58 }), shadow: true })
    const { decisions } = await h.engine.onCandleClose([viewOf('SOLUSDT'), viewOf('ETHUSDT')], NO_CONTEXT)
    expect(decisions.map((d) => [d.action.kind, d.shadow?.action])).toEqual([
      ['enter', 'enter'],
      ['blocked', 'blocked'],
    ])
    expect(h.engine.snapshot().accounts.shadow?.margenEnUso).toBe(42)
  })
})
