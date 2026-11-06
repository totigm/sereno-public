import { describe, expect, it } from 'vitest'
import { releaseExpiredPenalties, updateConfidence } from '../../src/learning/confidence'
import { applyWalkForward, WALK_FORWARD_DEFAULTS, type ParamCombo, type WalkForwardResult } from '../../src/learning/params'
import { applyReliability } from '../../src/learning/reliability'
import { initialLearningState, signalRecord, type LearningChange } from '../../src/learning/state'
import { updateWeightsFromTrade } from '../../src/learning/weights'
import { phraseLearning } from '../../src/journal/phrases'
import { DAY, LEARNING, makeClosed, signal, T0 } from '../learning/fixtures'

// Los mensajes salen de las funciones de aprendizaje reales: así el test cubre el
// texto que de verdad llega a `learning_log` (ids de señal, símbolos de contrato y
// el menos ASCII de `toFixed`).

// Estado con el trade 50 por cerrar: el primero que ya enseña.
const READY = { ...initialLearningState(T0), closedTrades: LEARNING.weightLearningMinTrades - 1 }
// Estado que ya puede ajustar parámetros (fuera del congelamiento inicial).
const TUNABLE = { ...initialLearningState(T0), closedTrades: LEARNING.weightLearningMinTrades }

function only(log: LearningChange[]): LearningChange {
  expect(log).toHaveLength(1)
  return log[0] as LearningChange
}

describe('phraseLearning', () => {
  it('pesos por trade: dice qué pesos subió y bajó, con nombres y contracciones', () => {
    const closed = makeClosed({
      rMultiple: 1.2,
      signals: [signal('trendHigher', 0.8), signal('funding', 0.5), signal('bands', -0.6)],
    })
    const change = only(updateWeightsFromTrade(READY, closed, LEARNING, T0).log)
    expect(change.message).toBe('Trade 50 en SOLUSDT (long, +1,20R): subí trendHigher, funding; bajé bands (n = 50).')
    expect(phraseLearning(change)).toBe(
      'Trade 50 en SOL (long, +1,20R): subí el peso de la tendencia mayor y del funding; bajé el peso de las bandas (n = 50).',
    )
  })

  it('pesos por trade: una sola señal, tres señales y R negativo con menos tipográfico', () => {
    const loss = makeClosed({ symbol: 'INJUSDT', side: 'short', rMultiple: -1, signals: [signal('momentum', 0.5)] })
    expect(phraseLearning(only(updateWeightsFromTrade(READY, loss, LEARNING, T0).log))).toBe(
      'Trade 50 en INJ (short, −1,00R): subí el peso del momentum (n = 50).',
    )
    const three = makeClosed({ signals: [signal('trend15m', 0.4), signal('vwap', 0.3), signal('btcRegime', 0.2)] })
    expect(phraseLearning(only(updateWeightsFromTrade(READY, three, LEARNING, T0).log))).toBe(
      'Trade 50 en SOL (long, +1,00R): subí el peso de la tendencia de 15 minutos, del VWAP y del régimen de BTC (n = 50).',
    )
  })

  it('fiabilidad: "de el" se contrae a "del" y la fiabilidad negativa conserva el menos tipográfico', () => {
    const rho = { ...signalRecord(0), momentum: 0.1, bands: -0.2 }
    const { log } = applyReliability(initialLearningState(T0), rho, LEARNING, T0, { sampleSize: 120 })
    expect(log.map((c) => c.message)).toEqual([
      'Subí el peso global de momentum de 1,00 a 1,05: fiabilidad 0,10 (n = 120).',
      'Bajé el peso global de bands de 1,00 a 0,90: fiabilidad −0,20 (n = 120).',
    ])
    expect(log.map(phraseLearning)).toEqual([
      'Subí el peso global del momentum de 1,00 a 1,05: fiabilidad 0,10 (n = 120).',
      'Bajé el peso global de las bandas de 1,00 a 0,90: fiabilidad −0,20 (n = 120).',
    ])
  })

  it('confianza y penitencia: nombre de la moneda y menos tipográfico', () => {
    const state = { ...initialLearningState(T0), confidenceBySymbol: { INJUSDT: -0.4 }, tradesBySymbol: { INJUSDT: 7 } }
    const closed = makeClosed({ symbol: 'INJUSDT', rMultiple: -1 })
    const { state: penalized, log } = updateConfidence(state, closed, LEARNING, T0)
    expect(log.map(phraseLearning)).toEqual([
      'Confianza en INJ: −0,40 → −0,42 tras −1,00R (n = 8).',
      'INJ queda en penitencia 7 días: confianza −0,42 tras 8 trades.',
    ])
    const released = releaseExpiredPenalties(penalized, T0 + LEARNING.penaltyDays * DAY)
    expect(phraseLearning(only(released.log))).toBe('INJ vuelve de la penitencia con confianza −0,20.')
  })

  it('parámetros: el resto del mensaje queda igual salvo el menos', () => {
    const current: ParamCombo = { theta: 0.35, k: 1.5, tpR: 2, trailingR: 1 }
    const candidate: ParamCombo = { theta: 0.4, k: 2, tpR: 3, trailingR: 1.5 }
    // La mejor candidata rinde menos que la vigente: queda rechazada por no significativa.
    const result: WalkForwardResult = {
      adopt: false,
      best: { params: candidate, expectancyR: 0.07, se: 0.04, trades: 75, validationExpectancyR: 0.05, validationTrades: 20 },
      current: { params: current, expectancyR: 0.12, se: 0.04, trades: 80, validationExpectancyR: 0.1, validationTrades: 20 },
      rejected: [{ params: candidate, expectancyR: 0.07, trades: 75, deltaR: -0.05, reason: 'not_significant' }],
      criteria: WALK_FORWARD_DEFAULTS,
    }
    const change = only(applyWalkForward(TUNABLE, result, LEARNING, T0).log)
    expect(phraseLearning(change)).toBe(
      'Sigo con θ 0,35 · k 1,5 · TP 2R · trailing 1R: la mejor candidata θ 0,4 · k 2 · TP 3R · trailing 1,5R quedó −0,05R por trade respecto de la vigente y no alcanzó (la mejora no supera 2 errores estándar).',
    )
  })
})
